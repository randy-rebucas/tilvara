# Runbook: production access

For: Tilvara engineering and operations. It says who may reach production, with which credential, and how
access is given, used, reviewed and taken away. The principle (SPEC §13, THREAT_MODEL T14): **Tilvara staff
have no standing access to any business's records.** Every path into those records is either the
business's own grant, or an ops credential used for a recorded reason.

Hosting is not chosen yet (D1), so host-level access (consoles, SSH, the managed database's admin login,
the secret manager's policies) is described as requirements; the concrete steps are added with slice 7.

## 1. Credentials and who holds them

| Credential | What it can do | Held by | Where it lives |
|---|---|---|---|
| `onepos_app` password (`DATABASE_URL`) | The API's runtime role: RLS forced, one business per transaction, no schema changes, no credential tables | The API processes only | Secret manager → API environment |
| `onepos_worker` password (`WORKER_DATABASE_URL`) | The worker: reads what exports need under RLS, writes no table, runs the outbox | The worker processes only | Secret manager → worker environment |
| `onepos_migrator` password (`DATABASE_MIGRATOR_URL`) | Schema owner. Can enter any business's context and, through `SET ROLE onepos_platform`, change platform tables (users, sessions, staff) | **Ops only**, at most two named people | Ops vault. Never on an app host, never in the API's or worker's environment |
| `onepos_backup` password (`BACKUP_DATABASE_URL`) | Reads every table of every business (BYPASSRLS, `pg_read_all_data`); writes only its run records | The backup job, and ops | Secret manager → backup job; ops vault |
| Database admin login (managed service, D1) | Everything, including roles | Ops only, break-glass | Ops vault, two-person |
| Backup secret key (age) | Decrypts every backup | Ops, two people can reach it | Ops vault; on the drill host only during a drill |
| `JWT_ACCESS_SECRET`, `MFA_ENCRYPTION_KEY` | Sign access tokens and export links; decrypt authenticator secrets | The API processes | Secret manager |
| Provider keys (PayMongo D6, email D2) | Payments; mail as Tilvara | The API/worker processes | Secret manager |
| Tilvara staff account (support) | Read-only view of a business **only while that business has an open grant**, every page audited in the business | Support staff, marked by ops | Their own password + authenticator |
| `onepos_readonly` | NOLOGIN; reads the global catalogs only (permissions, plans, extensions, discount schemes). As a login it could set `app.tenant_id` itself and read any business, so it was closed on 2026-10-27 (migration 0126) | Nobody: a reporting need gets its own design (e.g. a definer function per report) | — |

The app, worker and read-only roles are not superusers and cannot bypass RLS; `rls-catalog.test.ts`
checks every role's posture and grants.

## 2. When an ops credential may be used

Only for a reason that is written down first, in a ticket or the incident log:

- applying migrations (database-migrations.md);
- the support CLI: staff accounts, owner MFA resets (support-access.md, support-mfa-reset.md);
- setting a subscription or suspending a business (tenant-offboarding.md, security-incident.md);
- incident containment and investigation (security-incident.md);
- backups and restore drills (backup-restore.md);
- the traceability audit (it needs a login that can read every business; read-only work).

Not a reason: "having a look" at a business's records, answering a question a support grant could answer,
or fixing data by hand. A business's records are looked at through its support grant.

When using one:
1. Note in the ticket: who, when, which credential, why.
2. Prefer a tool that writes its own audit row (the support CLI, `dead-letters replay`, the platform
   functions) over raw SQL.
3. Raw SQL: wrap it in `BEGIN … COMMIT`, run the selection first and check its count, and paste the
   statements and their results into the ticket.
4. Never copy business records off the production host to a laptop. Diagnostics use counts, ids and
   the audit log. If records must leave (a business's dispute, a legal request), the DPO decides how.

## 3. Giving and taking away access

**Joining**: an ops credential is given by the other ops holder, after the person has read this runbook,
security-incident.md and the breach procedure. Record the date. Support staff are marked with
`support staff-add` (requires two-step sign-in).

**Leaving or changing role**, on the last day:
- `support staff-disable` for a staff account (ends any open support view at the next request);
- rotate every shared credential the person knew: the migrator and backup passwords, and the backup key
  if they could reach it (rotation steps: security-incident.md 2.5, backup-restore.md "Keys");
- remove them from the vault, the hosting console and the secret manager (D1).

**Quarterly review** (and after every incident that involved an ops credential):
- `pnpm --filter @1pos/database support staff-list`: every active staff member still needs it;
- the ops vault and hosting console members are the people named in section 1;
- the NULL-tenant audit rows of the quarter (`platform.*`, `auth.mfa.*`) each match a ticket;
- record the review's date and outcome in this file's history below.

## 4. Requirements for the hosting choice (slice 7)

- Separate production and staging accounts; nobody's day-to-day login can reach production.
- The database is reachable only from the app network and a bastion; no public address.
- The metrics ports and the worker are on the internal network only (monitoring.md).
- Console and bastion sign-in need two-step sign-in; sessions are logged and kept with the audit evidence.
- The secret manager grants each service only its own secrets.
- Edge and load-balancer logs (the only place client IP addresses exist) are kept for the period in the
  retention schedule and readable by ops only.

## Review history

| Date | Reviewer | Outcome |
|---|---|---|
| — | — | No production yet |
