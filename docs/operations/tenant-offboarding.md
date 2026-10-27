# Offboarding a business (leaving Tilvara)

What happens when a business stops using Tilvara, step by step. The rule throughout: **records are never
deleted early.** Philippine tax rules require books and records to be kept for at least 5 years (EOPT,
amended Sec. 235; see `docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md`), longer while a protest or refund is
pending. Personal data is anonymised only after that period ends. This runbook is an operating procedure,
not legal advice; the retention period is confirmed with the business's tax adviser and our DPO.

Design: ADR-0016 slice 6. Related: `support-access.md`, `backup-restore.md`.

## 0. Before you start

- Open a ticket. Confirm the request comes from the **owner**: the email on the account and a call-back
  to the number on file. Record what was checked.
- Ask whether the business wants support's help. If so, the owner gives support access first
  (Subscription → Support access), so staff can see what the owner sees.

## 1. Stop new activity on the tills

The owner (or an admin) does this in the back office:

1. **Close every open shift** (POS → Close shift). Quarantined offline sales must be reviewed first
   (Offline → recorded or dismissed with a reason); a shift will not close while some are waiting.
2. **Revoke every till** (Locations → register → till → Revoke). A revoked till stops selling and
   syncing at once. Sales still on a till that never synced are lost when it is revoked: check
   Offline → Tills shows nothing waiting.
3. Settle or cancel unresolved card/QR payments (a shift cannot close over them).

## 2. End the subscription → read-only

Until online billing exists (D6), ops sets the subscription with the support CLI (ops credentials,
`DATABASE_MIGRATOR_URL`). The business's address is its slug (`<slug>.tilvara.ph`, or the `/s/<slug>` link):

```sh
pnpm --filter @1pos/database support subscription-show --slug <slug>
pnpm --filter @1pos/database support subscription-set --slug <slug> --plan <current plan> --status CANCELED   --reason "Owner asked to leave Tilvara (call-back checked)" --ticket <ref>
```

Each change is written in the business's own audit log as `subscription.changed` (plan and status before
and after, who, why, the ticket), so the owner sees it too. The same command extends a trial
(`--status TRIALING --trial-ends <date>`), records a payment (`--status ACTIVE --paid-until <date>`) or
gives time to pay (`--status PAST_DUE --grace-ends <date>`); it refuses a date already past.

From then on the business is **read-only**: every page and report still opens, every write answers
`402 SUBSCRIPTION_READ_ONLY`. Every member sees why in a banner (the owner and admins with how to renew,
`ONEPOS_SUPPORT_EMAIL`); a till shows a red line, and sales it rings wait for review. Nothing is deleted.

If the business must also be blocked from writing even after a renewal (a dispute, a legal hold), set
the business itself to `SUSPENDED` (same effect on writes, `403 TENANT_SUSPENDED`):

```sql
-- as onepos_migrator, inside the tenant context
BEGIN;
SELECT set_config('app.tenant_id', '<tenant id>', true);
UPDATE tenants SET status = 'SUSPENDED', updated_at = now() WHERE id = '<tenant id>';
COMMIT;
```

## 3. The business takes its records

Read-only and suspended businesses can still do this (it is the one write they keep):

1. Owner/admin → **Subscription → Your records → Prepare a copy**.
2. The worker makes one ZIP from a single consistent snapshot: `README.txt`, `manifest.json`,
   `members.csv`, and `tables/<table>.csv` for every table of the business's records (sales, returns,
   tenders, shifts, stock movements, purchasing, journal, audit log, settings…). Credential hashes and
   internal queues are left out; the README lists them.
3. When it shows **Ready**, **Download**. Each click makes a link that works for 10 minutes; the file
   is kept 7 days, then deleted by the worker (`data_export.expired`). Up to 5 copies a day.
4. The owner checks the file opens and keeps it safe: it contains personal data (names, emails,
   SC/PWD IDs).

Every step is in the business's audit log: `data_export.requested`, `.ready` (size, SHA-256),
`.link_issued`, `.downloaded`, `.expired` (or `.failed`). The SHA-256 is shown on the page, so the owner
can confirm the file is the one made.

If an export shows **Could not be made**, it failed three times (the error is in the audit log). Check the
worker's logs and `dead-letters list`, fix the cause, and ask the owner to prepare a new copy.

## 4. Retention hold

- The business stays in the database, read-only, for the retention period. Sign-in keeps working for its
  members, so the owner can still read reports and take another copy.
- Backups keep containing it (they are encrypted; see `backup-restore.md`).
- Remove members who no longer need access (Team → Remove). Their accounts stay; only the membership ends.
- Revoke any open support access.
- Record in the ticket: the date the hold started and the earliest date it can end (5 years after the
  last filing deadline of the records, unless the tax adviser says otherwise).

## 5. After the retention period: anonymise

**Not automated yet.** When the period has ended (confirmed by the DPO and tax adviser):

- personal data in the business's records is pseudonymised: member names and emails (when the person has
  no other business), SC/PWD beneficiary names and ID numbers, supplier contact details, customer names;
- financial figures, document numbers and dates stay, so totals remain consistent;
- the business is set to `CLOSED`.

Until the anonymisation job exists (LEFTOVER), keep the business on hold and do not hand-edit tables:
financial, inventory and audit tables are append-only and refuse changes by design.

## Checklist

- [ ] Owner verified, ticket open
- [ ] Shifts closed, offline sales resolved, tills revoked, payments settled
- [ ] Subscription CANCELED (and SUSPENDED if needed)
- [ ] Copy of records prepared, downloaded, opened by the owner
- [ ] Members removed, support access ended
- [ ] Retention start and earliest end recorded
