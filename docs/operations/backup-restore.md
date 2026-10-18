# Runbook: backups, the restore drill, and restoring for real

ADR-0016 slice 4. The tools are `pnpm backup …` (`packages/database/src/backup-cli.ts`) and `pnpm drill:restore` (`infra/backup/drill-restore.mjs`). Alerts: [OneposBackupMissing](monitoring.md#oneposbackupmissing) and [OneposRestoreDrillOverdue](monitoring.md#oneposrestoredrilloverdue).

## What a backup is
- **A logical dump of the whole database** (`pg_dump -Fc`). It covers every tenant, the books, the audit log and the migration table.
- **Consistent to one instant.** The backup opens a read-only snapshot. It counts every table in that snapshot, and then `pg_dump` dumps the same snapshot (`--snapshot`). The manifest therefore describes exactly what the file holds, even while tills keep selling.
- **Encrypted at the source** with [age](https://age-encryption.org) to one or more public keys (`BACKUP_AGE_RECIPIENT`). The archive streams from `pg_dump` through the encryption to disk, so no plaintext copy is ever written. The database host and the backup store never hold the secret key.
- **A manifest** next to it (`onepos-<db>-<UTC time>.manifest.json`, not encrypted, with counts and catalog facts only). It records:
  - when the backup ran, by the DB clock;
  - the size and SHA-256 of the encrypted file;
  - the `pg_dump` and server versions;
  - the migration head;
  - the exact row count of every table;
  - the catalog posture: owners, grants, RLS flags, policies, SECURITY DEFINER functions, triggers, default privileges and extensions.
- **A `backup_runs` row** in the database for every success, written through `platform_record_backup()`. It feeds `onepos_backup_last_success_timestamp_seconds`. Failures write nothing and exit non-zero.

Not in the backup:
- **Redis.** It holds only rate-limit counters, which may be lost.
- **The tills' local stores.** Unsynced offline sales stay on the till and are delivered after a restore (see below).
- **Secrets**: `JWT_ACCESS_SECRET`, `MFA_ENCRYPTION_KEY`, provider keys. They live in the secret manager. **Without the same `MFA_ENCRYPTION_KEY`, restored two-step sign-in enrolments cannot be read**, and those users must set two-step sign-in up again.

## Keys
1. `pnpm backup keygen --out <file>` writes a new secret key (`AGE-SECRET-KEY-1…`) to `<file>` with owner-only permissions. It refuses to overwrite an existing file. It prints the public key line for `BACKUP_AGE_RECIPIENT`.
2. Put the secret key in the ops vault (two people can reach it). Keep it off the database host, the app hosts and the backup store. The drill host gets it only for the drill (`BACKUP_AGE_IDENTITY_FILE`).
3. **Rotation**:
   - generate a new key and set `BACKUP_AGE_RECIPIENT=<new>,<old>` for one retention period;
   - then set only the new key;
   - keep the old secret key until the last backup made for it has expired.
4. **Lost secret key**: every backup made for it is unreadable. Make a new key and take a backup at once.

The files are standard age files. The `age` command line (v1.1+) decrypts them too: `age -d -i key.txt file.dump.age > file.dump`. That writes plaintext to disk, so do it only on the drill host.

## Taking backups
Environment variables:
- `BACKUP_DATABASE_URL`: the `onepos_backup` login.
- `BACKUP_AGE_RECIPIENT`.
- `BACKUP_DIR`: relative paths are taken from the repository root.
- `BACKUP_KEEP_DAYS` (default 30).
- `PG_TOOLS_DOCKER=<container>`: set this when `pg_dump` is not installed on the host. The dev machine uses the compose Postgres container.

```
pnpm build
pnpm backup run            # encrypted dump + manifest + backup_runs row, then prunes old local copies
pnpm backup verify [<manifest>]   # size + SHA-256 of a copy (e.g. after copying it off-site)
```

**Schedule**:
- once a day (cron or Task Scheduler) at the quietest hour;
- before every production migration;
- before any manual data repair.

**Retention**: pruning deletes local copies older than `BACKUP_KEEP_DAYS` but always keeps the newest three. The off-site copy and its retention belong to the hosting choice (**D1**, object storage with versioning and a retention lock). Until D1, copy the `.dump.age` and `.manifest.json` pair off the machine yourself and run `backup verify` on the copy.

**The backup login** (`onepos_backup`) is `BYPASSRLS` + `pg_read_all_data`, because a dump must see every tenant. It writes nothing except its own run records. Treat its password like the migrator's: ops credentials only.
- New volumes: `infra/docker/postgres/init/01-roles.sql` creates it.
- Existing clusters: run `infra/docker/postgres/upgrade/2026-10-17-backup-role.sql` once, before migration 0052.

## RPO and RTO
- **RPO (data that can be lost)**:
  - Today it is the time since the last successful backup, so up to 24 hours with a daily schedule.
  - Point-in-time recovery from WAL brings it to minutes, but it comes with the hosting choice (D1): a managed Postgres's PITR. With PITR, the drill restores a PITR copy instead.
  - Until then, **sales recorded online after the last backup are lost from the cloud in a disaster**. They survive only as printed receipts and in the payment provider's records.
  - Offline sales still waiting on a till are not lost: the till delivers them after the restore.
- **RTO (time to serve again)**: measured by every drill, from the start of the drill to the API answering ready on the restored database.
  - The first drill on the dev machine (session 11) took **18.2 s**: 2.7 MB encrypted, 57,179 rows, 92 tables. The restore took 4.7 s and the API boot 13.2 s.
  - This is a measurement on a developer laptop with a small database, **not a production promise**. Production RTO is measured on the D1 staging size and recorded here.

## The restore drill
Monthly, after any change to the backup tooling, and after a migration that adds tables or grants:
```
pnpm build
pnpm drill:restore [<manifest>] [--keep] [--no-record]     # default: the newest backup in BACKUP_DIR
```
Needs:
- `BACKUP_AGE_IDENTITY_FILE` (the secret key, on the drill host only);
- `DRILL_ADMIN_URL`: a superuser login on the cluster the drill restores into. The roles must already exist there (`01-roles.sql`).
- `DATABASE_URL`: the runtime role. The drill points it at the scratch database.
- `BACKUP_DATABASE_URL`: where the passed drill is recorded.

What it does (each step must pass):
1. **File check**: size and SHA-256 equal the manifest.
2. **Restore**: decrypts the backup straight into `pg_restore --single-transaction` in a new database `onepos_drill_<time>`, owned like the original. The wrong key fails before anything is created. A corrupted file fails age's authentication, and the transaction leaves nothing behind.
3. **Verify**:
   - the migration head and every table's row count equal the manifest;
   - the catalog posture equals the backed-up one, compared item by item, so a missing grant or policy is named;
   - the tenant-isolation rules hold: every tenant table has ENABLE + FORCE RLS and only the canonical policy. These are the same rules as `rls-catalog.test.ts`.
4. **API on the restored database**: boots the built API as the runtime role (RLS on) and waits for `/v1/health/ready` (database up, migrations at head). The RTO is taken here.
5. **Smoke**: a new business signs up, sets up a branch, register, item and stock, opens a shift and rings up a ₱44.80 cash sale, then reads it back.
6. **Traceability audit** (`apps/api/test/dev-audit.ts`) over everything restored plus the smoke sale: stock, books and documents tie out.
7. **Record**: a `RESTORE_DRILL` row in the source database (`onepos_restore_drill_last_success_timestamp_seconds`). A report `…drill-<time>.json` (phases in ms, RTO, counts) is written next to the backup. The scratch database is dropped unless `--keep`.

A failed drill exits 1 and records nothing. Treat it as a **critical defect of the backups**: the last good backup is the last one whose drill passed.

## Restoring for real
Only with the incident lead's go-ahead. Write down the times as you go, because they are the real RTO.
1. **Stop writes**: scale the API and the worker to zero, or put them in maintenance. Tills keep selling offline (cash) and queue their sales.
2. **Pick the backup**: the newest whose drill passed, or the newest whose `backup verify` passes. Note its time: everything recorded online after it is lost (see RPO).
3. **Target cluster**: create the roles (`01-roles.sql`, with passwords from the secret manager).
4. **Restore**: run the drill with `--keep --no-record` against the target cluster (`--no-record` because the source database may be gone). It restores, verifies, boots and smoke-tests a copy, and leaves `onepos_drill_<time>` in place.
   - Then rename it: `ALTER DATABASE onepos RENAME TO onepos_broken_<date>; ALTER DATABASE onepos_drill_<time> RENAME TO onepos;` (no connections open).
   - Or restore with `pg_restore --single-transaction --exit-on-error -d onepos` into a new, empty `onepos` owned by `onepos_migrator`.
   - The smoke business ("Restore Drill Store", slug `drill-…`) stays in the restored database as a clearly named test tenant. Archive it after the incident; do not delete records.
5. **Secrets**: start the API with the same `JWT_ACCESS_SECRET` and `MFA_ENCRYPTION_KEY` as before.
6. **Start the API and worker**:
   - `pnpm db:migrate` must report nothing to apply, unless the build is newer than the backup.
   - `/v1/health/ready` must answer ok.
7. **Tills**: they reconnect by themselves and deliver their queued offline sales (ADR-0015). Re-sends are idempotent: nothing is counted twice, and a till restored from an old copy of its own store replays safely.
   - Watch `/offline-sales` for quarantined sales, for example a shift that the restore no longer shows as open.
8. **Tell the businesses** the backup time. Sales rung up online between then and the outage must be re-entered from printed receipts, as corrections, under the business's own records process. Tilvara never edits restored history.
9. **Afterwards**: run `dev-audit.ts` against the restored database and keep the broken database until the incident review closes.

## Managed Postgres (after D1)
- A managed service usually gives no superuser and offers point-in-time recovery. The drill then:
  - restores a PITR copy to a new instance with the provider's tools;
  - points `DRILL_ADMIN_URL` at that instance's admin login;
  - runs steps 3–7 (verify, API, smoke, audit, record).
- The logical backup stays as the second, provider-independent copy.
