# Runbook: security incidents

For: the incident lead and operator when an account, a secret, a till, a business or our data may be
compromised. Run it inside [incident-response.md](incident-response.md): a security incident is SEV1 until
shown otherwise. When personal data may have been seen, taken, changed or lost by someone not allowed to,
start the [breach procedure](../compliance/privacy/breach-procedure.md) **at the same time**. The NPC
72-hour clock starts when we know or reasonably believe it happened, not when the investigation ends.

Order of work: **contain → keep the evidence → find the extent → recover → notify.** Containment comes
first, but do not destroy evidence while containing (no restarts that lose logs you have not copied, no
deleting rows; the append-only tables protect most of it anyway).

## 1. Evidence: what exists and where

| Evidence | Where | Notes |
|---|---|---|
| Business activity | `audit_logs` of the business (admin → Audit log, or `GET /v1/audit-logs`) | Append-only. Every mutation, sign-in, support request, export step |
| Account events outside a business | `audit_logs` with NULL tenant: lockouts, refresh-token reuse, MFA changes, password resets, staff and support openings | Read as `onepos_migrator` with `SET ROLE onepos_platform` |
| Sessions | `user_sessions`: start, end, revoke reason, **user agent** | No IP address is stored anywhere in the database |
| Requests | API logs (JSON, stdout): route template, status, `correlation_id`, `tenant_id`, `user_id` | Never bodies, query strings or tokens. Log retention depends on hosting (D1) |
| Client IP addresses | Only the edge / load balancer logs (D1) | The API uses the IP in memory for rate limits and does not keep it |
| Exports | `data_exports` rows and `data_export.*` audit rows (who asked, link issued, downloaded) | Files are deleted after 7 days |
| Tills | `terminals` (status, last seen), `terminal_transactions` | A revoked till's local store stays on the PC |

Copy the relevant logs out of the hosting log store before they age out, and note the copy in the
incident log.

## 2. Containment levers

All SQL below runs as `onepos_migrator` (ops credentials), with `SET ROLE onepos_platform` for platform
tables. Every lever takes effect at the next request, because `AuthGuard` re-checks the session, the user
and the business on each request.

### 2.1 One person's account is compromised
1. **End their sessions and block sign-in** (ops credentials):
   ```
   pnpm --filter @1pos/database support account-disable --email <email> --reason "security incident" --ticket <ref>
   ```
   One transaction (`platform_account_disable`): status `DISABLED`, every session revoked
   (`ACCOUNT_DISABLED`), outstanding password-reset and email-change links voided, and a NULL-tenant audit
   row `platform.user.disabled` with actor, reason and ticket. Every session stops at its next request.
2. Look at what the account did: the audit log of every business it belongs to, from the earliest
   suspicious sign-in. Members, roles, prices, voids, returns, exports and support grants matter most.
3. **Recover**: when the owner of the account is verified (call-back to the number on file),
   `support account-enable --email <email> --reason "<how identity was checked>" --ticket <ref>`, have them
   reset the password (this revokes every session again) and reset
   two-step sign-in ([support-mfa-reset.md](support-mfa-reset.md)).
4. Anything the attacker created is corrected by the business as new documents (a return, a reversal, a
   price change back), never by editing rows. See [rollback-recovery.md](rollback-recovery.md).

### 2.2 A 1POS staff account is compromised
`pnpm --filter @1pos/database support staff-disable --email <email> --reason "security incident <ticket>"`
ends every open support view at the next request. Then 2.1 for the account itself. List the grants it
used from the NULL-tenant `platform.support.opened` rows; each affected business's audit log shows every
page read (`support.request`). Those businesses are told (breach procedure decides how).

### 2.3 A till is stolen or its credential leaked
Admin → Locations → register → till → **Revoke**. The till stops selling and syncing at once
(`TERMINAL_REVOKED`). Sales on it that never synced are lost with it. The local store on the stolen PC
holds the price snapshot and every sale it rang offline, synced or not. Those are cash sales without
SC/PWD details (the discount cannot be given offline), so the exposure is the business's prices and
sales history and the cashier ids; record it in the breach register and let the DPO judge it.

### 2.4 Everyone must sign in again
For a leaked `JWT_ACCESS_SECRET` or a suspected session-store leak:
1. Rotate `JWT_ACCESS_SECRET` in the secret manager and restart every API instance. Every access token
   stops working at once. Download links of data exports are signed with a key derived from it and stop
   working too (the owner makes a new link).
2. Revoke every session, so refresh tokens cannot mint new access tokens:
   ```sql
   BEGIN;
   SET LOCAL ROLE onepos_platform;
   UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'SECURITY_INCIDENT' WHERE revoked_at IS NULL;
   COMMIT;
   ```
3. Tills are not affected: they use their own terminal credentials. Rotate those by revoking and pairing
   each till again only if terminal credentials are in scope.

### 2.5 Other secrets
| Secret | If it leaks | Rotate |
|---|---|---|
| Database passwords (`onepos_app`, `onepos_worker`, `onepos_migrator`, `onepos_backup`) | Direct database access within that role's limits (the app and worker roles stay under RLS) | `ALTER ROLE <role> PASSWORD '<new>'` as an admin login, update the secret manager, restart the services that use it. The migrator and backup logins can read every business: their leak is a breach candidate |
| `MFA_ENCRYPTION_KEY` | With a database copy, an attacker can read authenticator secrets | [2.5.1](#251-rotating-the-mfa-key). If a database copy (or a backup and its age key) may have leaked **together with** the old key, rotating does not help those secrets: the people concerned set two-step sign-in up again (owner/admin reset, or [support-mfa-reset.md](support-mfa-reset.md)). Recovery codes are hashed and stay safe |
| Backup secret key (age) | Every backup made for its public key can be read by whoever also has the files | backup-restore.md "Keys" → rotation. If the files may also be exposed, treat as a breach |
| PayMongo keys (once D6) | Payments or refunds in our name | Roll the keys in the PayMongo dashboard, update the secret manager, restart; check the provider's log for activity we did not make |
| Email provider key (once D2) | Mail sent as 1POS (phishing our users) | Roll it with the provider; warn businesses not to follow unexpected mail |

#### 2.5.1 Rotating the MFA key
Also the yearly routine rotation. Nobody has to set two-step sign-in up again.
1. Make a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Deploy every API instance with `MFA_ENCRYPTION_KEY=<new>` and `MFA_ENCRYPTION_KEY_PREVIOUS=<old>`.
   New enrolments use the new key; secrets sealed with the old one still open (the API tries the new key,
   then the old one).
3. With ops credentials, check, then re-seal (one transaction; it changes nothing if any secret opens
   with neither key, e.g. a wrong old key):
   ```
   pnpm --filter @1pos/api mfa-rekey --check
   pnpm --filter @1pos/api mfa-rekey --reason "<routine rotation | incident>" --ticket <ref>
   ```
   It writes a NULL-tenant audit row `platform.mfa.rekeyed` with the counts.
4. Run `--check` again: every secret must be on the current key. Then deploy without
   `MFA_ENCRYPTION_KEY_PREVIOUS` and destroy the old key.

Tested by `account-privacy.test.ts` ("rotating MFA_ENCRYPTION_KEY"): a person enrolled under the old key
signs in with their app on an API that has only the new key.

### 2.6 A business must be stopped
Abuse, or an attacker in control of the owner's account who cannot be removed quickly: suspend the
business (every write answers `403 TENANT_SUSPENDED`; reading still works for its members). The SQL is in
[tenant-offboarding.md](tenant-offboarding.md) section 2. Lift it by setting `status = 'ACTIVE'` the same
way.

### 2.7 Cross-tenant exposure
Release-blocking. Stop the exposure first: roll back the release that introduced it
([rollback-recovery.md](rollback-recovery.md)), or block the route at the edge. Then find who saw what:
the route's logs give `tenant_id` and `user_id` per request, and the business's audit log shows writes.
Add the case to `apps/api/test/integration/isolation.test.ts` before the fix ships.

### 2.8 A dependency or build is compromised
Stop deploying. Identify the package and versions (`pnpm why <package>`), check whether the build that is
running includes it, and roll back to a build without it. Rotate every secret the running process could
read. Run `pnpm security:audit` and `pnpm security:bundles` on the fixed build.

## 3. Finding the extent

Answer these in the incident log, with the query or log search that answered each:

1. Which businesses? Which people (members, staff), and roughly how many customers (SC/PWD beneficiaries,
   takeaway names)?
2. Which data? Use the processing register to name the categories
   ([processing-register.md](../compliance/privacy/processing-register.md)).
3. Seen only, or also changed or taken? Exports and downloads leave `data_export.*` rows; support reads
   leave `support.request` rows; writes leave audit rows.
4. From when to when?
5. Is it contained? What proves it?

Example: how many SC/PWD beneficiary records a business holds in a window (as `onepos_migrator`, inside
the business's context; the platform role has no grant on business tables, so do not `SET ROLE` here):

```sql
BEGIN;
SELECT set_config('app.tenant_id', '<tenant id>', true);
SELECT count(*) AS sale_rows FROM sale_beneficiaries b JOIN sales s ON s.tenant_id = b.tenant_id AND s.id = b.sale_id
 WHERE s.completed_at BETWEEN '<from>' AND '<to>';
SELECT count(*) AS bill_rows FROM order_bill_beneficiaries;
COMMIT;
```

## 4. Recover and notify

- Recovery follows the lever's "recover" note above, then the verification list in incident-response.md
  section 3.
- Notification is decided with the DPO under the breach procedure: the NPC and data subjects within 72
  hours when the conditions are met, and each affected business without undue delay (target 24 hours),
  since for its records the business is the controller and carries the notification duty.
- The post-incident review (incident-response.md section 5) adds a test or control for the way in.
