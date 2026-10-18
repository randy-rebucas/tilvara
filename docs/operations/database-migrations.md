# Runbook: database migrations

For: the engineer who writes a schema change and the operator who applies it. The rules for *writing* a
migration are in `CLAUDE.md` (tenant tables, RLS, grants, back-fills); this runbook adds what they mean
when the change reaches a database with live businesses on it.

## How migrations work here

- **Files**: `packages/database/drizzle/NNNN_<name>.sql`, listed in `drizzle/meta/_journal.json`.
  - Schema changes: `pnpm db:generate` (drizzle-kit writes the DDL from `src/schema/**`).
  - Everything else (RLS policies, grants, triggers, functions, back-fills): a hand-written file from
    `pnpm --filter @1pos/database exec drizzle-kit generate --custom --name=<name>`.
- **Applying**: `pnpm build`, then `pnpm db:migrate`. It runs `packages/database/dist/migrate.js` as
  `DATABASE_MIGRATOR_URL` (`onepos_migrator`, the schema owner). **The API never migrates at boot**, and
  the runtime role cannot change the schema.
- **Cluster-level changes** (new database roles) are not migrations, since roles belong to the whole
  cluster. They live in `infra/docker/postgres/init/01-roles.sql` for new clusters and in
  `infra/docker/postgres/upgrade/<date>-<name>.sql` for existing ones, run once as an admin login
  **before** the migration that needs them.

What drizzle actually does, and why it matters:

1. **All pending migrations run in one transaction.** If any statement fails, nothing is applied, not
   even the earlier files of the same run. The good side: a failed run leaves the schema exactly as it
   was. The cost: locks taken by the first file are held until the last one finishes.
2. **A migration is applied only when its journal `when` is newer than the newest one already applied.**
   A file whose timestamp is older (a rebase, a hand-edited journal, a file without a journal entry) is
   **skipped without an error**. `packages/database/test/unit/migrations.test.ts` fails on out-of-order
   timestamps, missing files and orphan files.
3. Statements that cannot run inside a transaction are impossible: `CREATE INDEX CONCURRENTLY`, `VACUUM`.
   The same unit test refuses them.
4. drizzle records a hash per file but never compares it. **Never edit a migration that has run
   anywhere**: the change would apply on fresh databases only, and environments would drift apart
   silently. Write a new migration.

## Expand → deploy → contract

The API's readiness accepts a schema that is **newer** than the build expects and refuses one that is
older (`OneposSchemaBehind`, `GET /v1/health/ready` → `checks.migrations`). So the order is always:

1. **Expand** (migration): add tables, columns (nullable or with a constant default), functions, grants.
   The running build ignores them.
2. **Deploy** the new build, which uses them.
3. **Contract** (a later migration, in a later release, once no running build reads the old shape):
   drop or rename columns, tighten constraints.

Never drop, rename or retype something the running build reads in the same release that stops reading
it. Rolling back the code is then always possible up to the last contract
([rollback-recovery.md](rollback-recovery.md)).

Old desktop tills are clients too: a terminal route must keep answering the shape released tills
expect until every till has updated (as `GET /v1/terminal/snapshot` did when paging arrived).

## Locks and size

Every DDL statement takes a lock on its table, held until the whole run commits (point 1 above). On the
busy tables (`sales`, `sale_lines`, `sale_tenders`, `stock_movements`, `journal_entries`,
`journal_lines`, `audit_logs`, `outbox_events`, `idempotency_records`), a lock that blocks writes stops
checkout for every business.

| Change | Blocks checkout? |
|---|---|
| New table, function, policy, grant | No |
| Add a nullable column, or one with a constant default | Only for an instant (metadata only) |
| Add a column with a volatile default (`now()`, `uuidv7()`), change a column's type | **Yes, while the table is rewritten** |
| `CREATE INDEX` (non-concurrent, the only kind possible here) | **Yes, writes wait until the index is built** |
| Add a `CHECK` or foreign key | Yes, while existing rows are checked. Add it `NOT VALID`, then `VALIDATE CONSTRAINT` in a later migration (validation does not block writes) |
| Back-fill (`UPDATE` of existing rows) | Locks those rows; on an append-only table the trigger refuses it (see below) |

For a migration that touches a busy table:
- start the file with `SET LOCAL lock_timeout = '5s';` so it fails fast instead of queueing every
  checkout behind it (it applies to the rest of the run's transaction);
- time it on a restored copy of production first (procedure step 2);
- apply it in the quietest hour, and tell businesses if the copy took more than a few seconds.

**Append-only tables** (sales, stock, books, audit, payment events…) refuse `UPDATE` and `DELETE` even for
the schema owner. Do not disable the trigger to back-fill them: add a new column that is filled for new
rows, or a side table, and leave history as it was recorded.

**Back-fills under FORCE RLS**: the migrator sees no rows of a tenant table without a tenant context. A
back-fill wraps every table it reads or writes in `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` / `FORCE`
(see 0014, 0023, 0029, 0049), otherwise it silently touches nothing. Always check row counts after
applying (step 5).

## Procedure for a production migration

Until deployment exists (slice 7, D1/D3), this is done by hand from a trusted machine with the ops
credentials. Write each step's time and result in the change ticket.

1. **Review** the files against the checklist:
   - [ ] journal entries in order, unit test green (`pnpm --filter @1pos/database test`);
   - [ ] expand only, or a contract whose old shape no running build reads;
   - [ ] new tenant tables: `tenant_id`, `UNIQUE(tenant_id, id)`, composite FKs, ENABLE + FORCE RLS,
         grants for `onepos_app`, a worker grant or export exclusion; `rls-catalog.test.ts` and
         `isolation.test.ts` green;
   - [ ] back-fills wrapped in NO FORCE / FORCE for every table they read;
   - [ ] busy tables: `lock_timeout` set, `NOT VALID` constraints;
   - [ ] any cluster upgrade script listed, to run first;
   - [ ] the full integration gate green on this exact build (`turbo run test:integration
         --concurrency=1 --continue --force`).
2. **Rehearse on a copy of production**: `pnpm drill:restore --keep --no-record` restores the newest
   backup into `onepos_drill_<time>`. Run `pnpm db:migrate` with `DATABASE_MIGRATOR_URL` pointing at that
   database and time it. Then run the traceability audit on it (`AUDIT_DATABASE_URL=… pnpm --filter
   @1pos/api exec tsx test/dev-audit.ts`). Drop the copy afterwards.
3. **Back up**: `pnpm backup run` (backup-restore.md). The backup's time is the point a failed migration
   could, at worst, be restored to.
4. **Apply**: `pnpm db:migrate`. It prints `Migrations applied` or `Migration failed: …` and exits 1.
5. **Verify**:
   - `SELECT * FROM platform_migration_head();` shows the new count;
   - `onepos_schema_migrations_behind` is 0 on the running API (it still runs the previous build, which
     accepts a newer schema);
   - back-fills: the row counts you expected (compare with the rehearsal);
   - the traceability audit shows no new violations.
6. **Deploy** the build that uses the change. Check readiness on every instance.
7. **Record** in the change ticket and in `docs/STATUS.md`: migrations applied, timings, backup used.

## When it fails

- **During `db:migrate`**: the transaction rolled back, nothing was applied, and the running build is
  unaffected. Read the Postgres error (`err.cause` in drizzle's message), fix it **in a new or corrected
  file that has never run anywhere** (an unapplied file may still be corrected), and start again at
  step 1.
- **`lock_timeout` hit**: nothing applied. Retry in a quieter moment, or split the migration so the busy
  table's change runs alone.
- **Applied, but wrong** (a bad back-fill, a missing grant that breaks a route): do not restore the
  backup for this; it would lose every sale since. Fix forward with a new migration
  ([rollback-recovery.md](rollback-recovery.md) "Forward recovery"). A missing grant shows as
  `permission denied` on one route while readiness stays ok.
- **The new build will not become ready** (`OneposSchemaBehind`): migrations were not applied to the
  database it points at. Apply them, or roll the build back.
