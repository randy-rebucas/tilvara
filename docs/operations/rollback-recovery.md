# Runbook: rollback and forward recovery

For: the incident lead and operator after a bad release, or when wrong records were written. The rule:
**roll code back, roll data forward.** Builds can be swapped back; recorded history cannot be undone,
only corrected by new documents that point at the wrong ones.

## 1. Decide which case you are in

| What happened | Do |
|---|---|
| A new API, worker or admin build misbehaves, and its release had no migration, or only an expand migration | **Roll back the build** (section 2). The schema stays; the old build accepts a newer schema |
| The release included a contract migration (dropped or renamed something the old build reads) | **Fix forward** with a new build. The old build cannot run on the new schema |
| A migration applied but is wrong (bad back-fill, missing grant) | **Fix forward** with a new migration (section 4) |
| Wrong records were written (a defect priced, taxed, costed or posted wrongly) | Stop the cause, then **correct with new documents** (section 4) |
| Data is lost or the database is corrupted | **Restore** ([backup-restore.md](backup-restore.md) "Restoring for real"). Never restore just to undo a bad release: it loses every sale since the backup |
| A desktop till build misbehaves | Section 3 |

## 2. Rolling back a server build

Until deployment exists (slice 7: images, staging, CI), "a build" is the commit the servers were built
from. Keep the previous build's artefacts until the new one has run a full business day.

1. Confirm the previous build ran on the current schema: the release notes or ticket list the migrations
   of each release. If the release being rolled back included **only** expand migrations, it did.
2. Stop the new build's instances one at a time and start the previous build's in their place. Readiness
   must answer ok on each (`checks.migrations: up`) before the next.
3. Roll back the worker the same way if it changed. Outbox events stay queued and are picked up by the
   previous worker; an event type it does not know goes `DEAD` after its retries and can be replayed once
   a fixed worker runs (`pnpm --filter @1pos/workers dead-letters replay … --reason "…"`).
4. Admin web: restart the previous `next start` build. Sessions survive (cookies hold the same tokens).
5. Do not roll the schema back. drizzle has no down migrations, and the extra columns or tables are
   harmless to the old build.
6. Verify (incident-response.md section 3 step 5), then open a defect for the cause.

Requests that were in flight during the swap are safe: clients keep their Idempotency-Key on no answer or
a 5xx and retry, so nothing is recorded twice.

## 3. Desktop tills

The till keeps its own SQLite store with unsynced and synced sales, and migrates that store forward when
a new build starts. An older build may not read a store a newer build migrated.

1. **Sync first.** Admin → Offline → Tills shows nothing waiting for that till.
2. Install the previous build over the new one. The store records its version and an older build does
   not migrate it back, so it runs on the newer layout; if it misbehaves, do not delete the store
   folder while anything is unsynced. Pair the till again under a fresh profile only once it has
   synced (offline-terminal-recovery.md, "The till PC breaks").
3. A server rollback never needs a till rollback: terminal routes keep the shape released tills expect
   (database-migrations.md).

## 4. Forward recovery

### After an outage
Nothing is replayed by hand. Check that the automatic recovery finished:
- **Retries**: tills and counters retried their writes with the same Idempotency-Key, so each was
  recorded once. `onepos_idempotency_total{outcome="replayed"}` rises; that is expected.
- **Offline sales**: desktop tills deliver their queues by themselves. Watch Offline → Tills until nothing
  is waiting, then Offline → To review for quarantined sales (offline-terminal-recovery.md section 3).
- **Card/QR payments** caught mid-way: resolve every intent without an outcome before closing shifts
  ([payment-reconciliation.md](payment-reconciliation.md)).
- **Outbox**: the backlog drains on its own; `dead-letters list` shows what gave up.
- **Audit**: run the traceability audit over the outage window. It must show no violation.

### Wrong records written by a defect
1. **Stop the cause** first: roll back the build, or block the route, or turn the feature off.
2. **Find every affected document.** Write the selection down (business, branch, document type, time
   window, the defect's signature) and count them. The traceability audit and the reports are the
   starting point. Keep the list in the incident log.
3. **Correct with the document type the domain already has**, through the API, so each correction is
   authorised, audited and posted to the books in the same transaction:

   | Wrong | Correction |
   |---|---|
   | A sale (price, tax, lines) | A return of the sale, then the sale rung again correctly. The customer is refunded or charged the difference under the business's process |
   | A journal entry | `POST /v1/journal-entries/:id/reverse`, then a correct manual entry (`POST /v1/journal-entries`) |
   | Stock quantities | A stock count of the affected items (Inventory → Counts), or an adjustment with its reason |
   | Stock cost | A count does not change past cost. Raise it with the accountant: a manual journal entry between inventory and COGS |
   | A price, tax profile or setting | A new effective-dated version. Past documents keep the version they were recorded with |

4. **Closed periods**: corrections are dated in the open period. Reopening a closed period
   (`POST /v1/accounting/periods/reopen`) is the accountant's decision, audited, and never ops'.
5. Corrections are made by the business's own staff with support's guidance; support access is
   read-only by design. When there are too many documents to correct by hand, a correction script is a
   reviewed change that calls the same services in the business's context, is tested on a restored copy
   first, and is listed in the incident review. No such script exists today.
6. Tell each affected business what was wrong, what was corrected, and what to check (receipts already
   printed stay as printed; the correction documents explain the difference).

### A wrong migration
Write a new migration that repairs it (a missing grant, a corrected function, a new column filled
correctly), and apply it with the normal procedure ([database-migrations.md](database-migrations.md)),
including the rehearsal on a restored copy. Never edit the applied file and never hand-edit rows.
