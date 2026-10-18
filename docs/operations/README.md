# Operations runbooks

For: whoever runs 1POS in production or is on call. Each runbook is an operating procedure for the system
as built. Where a step waits on a decision (hosting D1, email D2, git remote/CI D3, PayMongo D6; see
ADR-0016), the runbook says so instead of inventing the step.

| When | Runbook |
|---|---|
| Something is broken or at risk, and you need to decide how serious it is and who does what | [incident-response.md](incident-response.md) |
| An account, secret, till or business may be compromised, or data may have leaked | [security-incident.md](security-incident.md), then [the breach procedure](../compliance/privacy/breach-procedure.md) when personal data is involved |
| An alert fired | [monitoring.md](monitoring.md) (one section per alert) |
| Backups, the monthly restore drill, restoring for real | [backup-restore.md](backup-restore.md) |
| Changing the database schema | [database-migrations.md](database-migrations.md) |
| A release went wrong, or wrong records were written | [rollback-recovery.md](rollback-recovery.md) |
| Card/QR payments without an outcome, end-of-day drawer and tender checks | [payment-reconciliation.md](payment-reconciliation.md) |
| A till lost its connection, broke, or was stolen | [offline-terminal-recovery.md](offline-terminal-recovery.md) |
| A business leaves 1POS | [tenant-offboarding.md](tenant-offboarding.md) |
| 1POS support needs to look at a business | [support-access.md](support-access.md) |
| An owner or member lost their authenticator | [support-mfa-reset.md](support-mfa-reset.md) |
| Block or unblock one account (incident, data subject request) | [security-incident.md 2.1](security-incident.md#21-one-persons-account-is-compromised): `support account-disable` / `account-enable` |
| Rotate `MFA_ENCRYPTION_KEY` (yearly, or after a leak) | [security-incident.md 2.5.1](security-incident.md#251-rotating-the-mfa-key) |
| A person asks about, corrects or wants to close their account | [data-subject-requests.md](../compliance/privacy/data-subject-requests.md) (they can do most of it on Your account) |
| Who may reach production, with which credentials | [production-access.md](production-access.md) |

SPEC §16 asks for these documents. Where each one is:

| SPEC §16 item | Document |
|---|---|
| Incident response | incident-response.md |
| Backup and recovery | backup-restore.md |
| Database migration procedures | database-migrations.md |
| Rollback and forward-recovery procedures | rollback-recovery.md |
| Payment reconciliation | payment-reconciliation.md (card/QR parts complete once the PayMongo adapter exists, D6) |
| Offline terminal recovery | offline-terminal-recovery.md |
| Tenant offboarding | tenant-offboarding.md |
| Production access | production-access.md |
| Security incident handling | security-incident.md |

The privacy pack for the Data Protection Officer (processing register, privacy notice draft, retention
schedule, breach procedure, processing agreement outline, data subject requests) is in
[`docs/compliance/privacy/`](../compliance/privacy/README.md).

## Conventions used in the runbooks

- **Ops credentials** are the migrator login (`DATABASE_MIGRATOR_URL`) and the backup login. They are never
  on an app host and never in the API's environment. See production-access.md.
- SQL blocks say which role runs them. "As `onepos_migrator`, then `SET ROLE onepos_platform`" means the
  statement touches platform tables (users, sessions) that only the platform role may change.
- Times in the database and in audit rows are UTC. Business days follow each branch's time zone.
- Records are never deleted or edited to fix a problem. Financial, inventory and audit tables are
  append-only by trigger. A correction is a new document (a return, a reversal entry, a stock count).
