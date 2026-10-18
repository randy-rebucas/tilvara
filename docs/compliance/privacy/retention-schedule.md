# Retention schedule (draft)

> **DRAFT, NOT LEGAL ADVICE.** Periods marked *proposed* are engineering's suggestions for the DPO to
> confirm or change. Fiscal periods follow `../PH_COMPLIANCE_ASSUMPTIONS.md` §1 and must be confirmed by
> the tax adviser.

The rule from the IRR of the Data Privacy Act: keep personal data only as long as needed for its purpose,
for legal claims, or as a law requires. For Tilvara this means two clocks:

- **Fiscal records** of a business (sales, returns, SC/PWD records, books, stock, purchasing, the audit
  trail around them) are kept for the period tax law requires. They are never deleted early, even when
  the business leaves or a person asks (data-subject-requests.md). When the period ends, the personal
  data in them is **anonymised** and the figures stay.
- **Everything else** is kept only while it serves its purpose, then deleted.

**Fiscal retention period.** Books and records: at least **5 years** from the day after the filing
deadline (or the filing date if filed late), longer while a protest, refund claim or audit is pending (EOPT,
amended Sec. 235). The compliance assumptions recommend making it configurable with 10 years as a safe
default; that is a question for the tax adviser (question 13 there). Below, "fiscal period" means this
period, counted from the end of the taxable year the record belongs to.

"Enforced" says whether the system does it today: ● yes, automatically · ◐ partly · ○ not built.

| Data | Where | Kept for | Why | Enforced |
|---|---|---|---|---|
| Sales, returns, voids, tenders, payment events, cash movements and counts | Sales tables (append-only) | Fiscal period, then anonymise staff and customer fields | Tax records | ◐ Kept (cannot be deleted); anonymisation job ○ |
| SC/PWD beneficiary name, ID number, TIN | `sale_beneficiaries`, `order_bill_beneficiaries` | Fiscal period, then anonymise | RR 5-2017 SC/PWD sales book | ◐ Kept; anonymisation ○ |
| Takeaway customer names, order notes | `restaurant_orders` | *Proposed:* 90 days after the order closes, then cleared | Only needed to call the order out | ○ |
| Journal, stock movements, purchasing, supplier returns | Books, stock, purchasing tables | Fiscal period | Tax and accounting records | ◐ Kept; anonymisation of supplier contacts ○ |
| Supplier contact details | `suppliers` | While the business uses the supplier, plus the fiscal period of the last document | Purchasing records | ○ (archive only) |
| Audit log of a business | `audit_logs` | Fiscal period of the business's records | Proof of who did what; part of the audit trail | ◐ Kept (append-only, cannot be truncated); no expiry ○ |
| Platform audit rows (lockouts, MFA, resets, staff, support openings) | `audit_logs`, NULL tenant | *Proposed:* 5 years | Security investigations, claims | ◐ Kept; no expiry ○ |
| Account: email, name, password hash, status | `users` | While the account exists. *Proposed:* on closure, anonymise once the person is no longer named in any business's records within their fiscal period; until then block (status `DISABLED`) | Contract; accountability on fiscal records | ◐ Closure blocks at once (`closed_at`); no anonymisation job |
| Sessions incl. user agent | `user_sessions` | *Proposed:* 90 days after expiry or revocation (a refresh token lives 30 days) | Security: spotting a stolen session | ○ Kept for ever |
| Password reset tokens (hashed) | `password_reset_tokens` | *Proposed:* 7 days after expiry (they expire after 30 minutes) | Abuse investigation | ○ Kept for ever |
| Email change requests: the new address, the link hash | `email_change_tokens` | *Proposed:* 7 days after expiry (they expire after 24 hours); the address of a request never confirmed is someone's personal data with no further use | Abuse investigation | ○ Kept for ever |
| Two-step sign-in secret, recovery codes | `user_mfa_factors`, `user_mfa_recovery_codes` | While enrolled; removed on reset or turn-off | Security | ● (removed on reset/turn-off) |
| Memberships, roles | `tenant_memberships`, `membership_roles` | While the person is a member; a removed membership stays as status `REMOVED` for accountability | Access control | ◐ |
| Invitations | `member_invitations` | *Proposed:* 90 days after expiry or acceptance | Onboarding | ○ |
| Support grants and support activity | `support_grants`, `audit_logs` | Same as the business's audit log | Accountability to the business | ◐ |
| Tilvara staff records | `platform_staff` | While staff, plus 5 years | Accountability | ○ |
| Request replay cache | `idempotency_records` | 24 hours | Safe retries only | ● Hourly purge by the worker |
| Outbox events | `outbox_events` | *Proposed:* 90 days after delivery (DONE) or replay | Delivery and its troubleshooting | ○ Kept for ever (ids only in payloads today) |
| Data export files | Private file storage | 7 days (`DATA_EXPORT_RETENTION_DAYS`, 1–30) | Owner's download | ● Hourly sweep deletes the file; the request row stays |
| Backups | Backup store | 30 days locally (`BACKUP_KEEP_DAYS`, newest three always kept); off-site per D1 | Disaster recovery | ● Local pruning; off-site ○ (D1) |
| Offline sales on the till PC | `till.sqlite` on the business's PC | *Proposed:* 30 days after they are recorded in the cloud | Till recovery | ○ Kept for ever |
| Application logs | Host log store | *Proposed:* 30 days | Operations, incidents | ○ Depends on hosting (D1) |
| Edge / load-balancer logs (client IP addresses) | Host | *Proposed:* 30 days | Security investigations | ○ D1 |
| Metrics | Metrics store | Host default; no personal data | Operations | — |
| Email delivery records | Email provider | Provider default; set to the shortest offered | Delivery problems | ○ D2 |

## When a business leaves

[tenant-offboarding.md](../../operations/tenant-offboarding.md): read-only, export, **retention hold** for the
fiscal period of its last records, then anonymisation of personal data. The business's records stay in
backups until those backups age out. The earliest end date is recorded in the offboarding ticket.

## Anonymisation (not built)

When the fiscal period of a business's records ends (confirmed by the DPO and the tax adviser), the
anonymisation job, once built:
- replaces SC/PWD names, ID numbers and TINs with a fixed marker, keeping scheme and amounts;
- clears takeaway names and free-text notes;
- replaces supplier contact fields;
- replaces member identities on records with a stable pseudonym per person (so "one cashier" is still
  visible), and anonymises the account itself when it has no other business;
- keeps every figure, number and date, so totals still reconcile.

The append-only triggers refuse these changes by design, so the job needs its own reviewed, audited path
(a SECURITY DEFINER function that may change only those columns). Until it exists, records on hold are
left untouched.

## What has to be built (LEFTOVER)

1. Purge jobs in the worker for sessions, reset tokens, email change requests, invitations and delivered outbox events, with the
   periods above once the DPO confirms them.
2. A local purge of recorded offline sales on the till.
3. The anonymisation job for closed accounts (closure itself is built: it blocks at once).
4. A configurable fiscal retention period per business (if the tax adviser confirms it can differ).
