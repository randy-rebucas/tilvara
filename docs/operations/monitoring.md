# Runbook: monitoring and alerts

For: whoever is on call for Tilvara. Background: ADR-0016 slice 3. The alert rules are in
`infra/monitoring/alerts.yml`; each rule links to its section below.

## What is measured, and where
| Source | Address | What |
|---|---|---|
| API | `http://<METRICS_HOST>:<API_METRICS_PORT>/metrics` (default `127.0.0.1:4329`) | HTTP, checkout, payments, offline sync, refusals, DB pool, Redis, and the business gauges |
| Worker | `http://<METRICS_HOST>:<WORKER_METRICS_PORT>/metrics` (default `127.0.0.1:4339`) | outbox batches and outcomes, webhook deliveries, loop errors, heartbeat, DB pool |
| Readiness | `GET /v1/health/ready` on the public API port | database, migration head, Redis |

- The metrics ports serve only `GET /metrics`. They must stay on the internal network: never route the
  public edge to them. `METRICS_HOST` is the address they bind to; `0` as a port turns one off.
- **`METRICS_TOKEN`** (API and worker, at least 32 characters): when set, a scrape must send
  `Authorization: Bearer <token>`; anything else gets 401. Production refuses to boot without it once
  `METRICS_HOST` is not a loopback address (a container or a private network), so a misplaced port still
  shows nothing. In Prometheus: `authorization: { type: Bearer, credentials_file: /etc/prometheus/tilvara-metrics-token }`
  on both jobs. Rotating it: set the new token in the scraper and the services together; a scrape in between
  fails (`up == 0` for one interval), nothing else does.
- A wrong or missing token shows as `up == 0`, like a stopped service; Prometheus's targets page then
  says "server returned HTTP status 401".
- The **business gauges** (`onepos_outbox_*`, `onepos_payment_intents_*`, `onepos_offline_sales_*`,
  `onepos_tills_*`, `onepos_cashier_sessions_*`, `onepos_worker_heartbeat_age_seconds`, `onepos_workers_alive`)
  come from the database function `platform_metrics()`. They are counts and ages across all businesses, with
  no business's records, names or ids. The API queries them at most every 10 seconds, however often it is
  scraped. When the query fails, `onepos_db_up` is 0 and the business gauges keep their last values.
- Each API replica exports the same business gauges. Use `max()` across replicas, never `sum()`.
- Counters (`*_total`) are per process. Use `sum(rate(...))` or `sum(increase(...))` across replicas.
- Scrape every 30 s. Jobs: `onepos-api` and `onepos-worker` (the rules use these names).

**Readiness** answers 503 when the database is unreachable or lacks the migrations this build needs, so the
load balancer stops sending traffic. A Redis outage does **not** fail readiness: rate limits fall back to
per-instance counting (ADR-0016 slice 2), and draining every replica would turn a Redis outage into a full
outage. The answer then is `200 {"status":"degraded"}` and `OneposRedisDown` fires.

Not measured yet: backup age (slice 4, backup and restore), billing failures (no billing integration yet),
traces (the OTel exporter waits for the hosting decision, D1).

## Severities
- **critical**: selling or recording is affected now. Act at once.
- **warning**: something degrades or piles up. Act within the working day.
- **info**: a trend for the operations review. No page.

---

## Availability

### OneposApiDown
An API instance stopped answering scrapes.
1. Check the process or container (crashed, out of memory, restarting).
2. Check its last log lines (JSON on stdout). Look for `EnvValidationError` on boot: the config refuses unsafe
   production settings.
3. While other replicas are ready, tills keep working. If none is, the desktop tills sell cash offline and
   send the sales later (`docs/operations/offline-terminal-recovery.md`).

### OneposDatabaseUnreachable
The API cannot query Postgres. Checkouts answer `503 SERVICE_UNAVAILABLE`; clients keep their
Idempotency-Key and retry, so nothing is recorded twice.
1. Check the database host or managed service status, connections (`max_connections`) and disk.
2. When it is back, nothing needs replaying by hand: tills retry with the same keys, and offline tills sync.
3. Afterwards, run the traceability audit (`apps/api/test/dev-audit.ts`) on the affected day.

### OneposSchemaBehind
This API build expects migrations the database does not have, so the instance reports not ready.
1. A deploy put the new API in front of an old schema. Migrations run separately, never at app boot.
2. Run the migrations (`pnpm db:migrate`, as the migrator role), or roll the API back to the previous build.
3. `GET /v1/health/ready` shows `checks.migrations`.

### OneposDbPoolSaturated
Requests wait for one of the API's 20 database connections.
1. Look for slow queries (`pg_stat_activity`, longest `now() - query_start`) and locks (`pg_locks` with `granted = false`).
2. A report over a long range or a burst of checkouts can cause it. If it persists, add API replicas
   before raising the pool size (the database's connection limit is shared by every replica).

### OneposDbConnectionsLost
Idle connections keep dropping: database restarts, failover, or a network device closing idle connections.
The pool replaces them by itself; this alert is about the cause.

### OneposHttpErrors
More than 2% of requests fail with 5xx.
1. `sum by (route, status) (rate(onepos_http_requests_total{status=~"5.."}[5m]))` shows where.
2. 503s usually mean the database (see above). 500s are defects: find the `correlationId` in the API log
   (the error envelope carries it) and open a defect.

### OneposEventLoopLag
The API's event loop is blocked for more than 200 ms (p99), so every request on that instance waits.
Usually CPU starvation (container limit) or a large synchronous job. Check CPU throttling, then recent deploys.

## Checkout and payments

### OneposCheckoutFailing
More than 5% of online checkouts (`POST /v1/sales`) fail with a server error.
1. Usually the database: check `OneposDatabaseUnreachable` and `OneposDbPoolSaturated` first.
2. Cashiers see "could not confirm". They keep the same sale on screen and retry; the server records it once.
3. Refusals (4xx: stale total, session closed, duplicate transaction) are not counted here.
   They are in `onepos_checkout_total{outcome="refused"}`.

### OneposCheckoutSlow
Checkout p95 is above 500 ms (the ADR-0016 target for the pilot).
1. Compare with `onepos_http_request_duration_seconds` for `/v1/tax/quote` and lookups. If everything is slow,
   it is the database or CPU; if only checkout, look at the stock and ledger triggers (large baskets).
2. Note the time and register; slice 5's load harness reproduces it.

### OneposIdempotencyKeyReuse
Clients sent the same Idempotency-Key with a different body (`422 IDEMPOTENCY_KEY_REUSED`). That is a client
defect: a till that reuses keys across sales could have a sale refused. Find the route in
`onepos_http_requests_total{status="422"}` and the client version, then open a defect.
`onepos_idempotency_total{outcome="replayed"}` (safe retries) is normal.

### OneposPaymentUnresolved
A card/QR payment has waited more than 15 minutes for its outcome (`PROCESSING` or `UNKNOWN`). The customer
may or may not have been charged. **Never charge again before it is resolved.**
1. The cashier or a manager presses "Check payment" on the POS (`POST /v1/payment-intents/:id/reconcile`).
   It asks the provider and settles the intent.
2. A shift cannot close while payments are unresolved; that is by design.
3. If the provider has no record, reconciliation marks it failed and nothing was charged.

### OneposPaymentFailures
Many payments were declined or timed out in 15 minutes. Check the provider's status page, then the
outcome split: `sum by (outcome) (increase(onepos_payment_outcomes_total[15m]))`. Many `unknown` outcomes
mean timeouts: check the network path to the provider and `PAYMENT_TIMEOUT_MS`.

## Offline tills

### OneposTillSilent
A till whose register has an open shift has not been in touch for 30 minutes or more. It is probably offline,
possibly with sales on board.
1. In the admin, open **Offline → Tills** to see which till and since when.
2. Call the store: is the till on, and does it show "Offline · N to send"? Follow
   `docs/operations/offline-terminal-recovery.md`.

### OneposOfflineSalesQuarantined
An offline sale that the server could not record (shift closed elsewhere, price or member changes, revoked
cashier…) has waited more than 4 hours for a manager. The sale happened, so the money is in a drawer.
A manager reviews it in the admin under **Offline → To review**: record it again or dismiss it with a reason.
The shift cannot be closed until it is resolved.

## Outbox and worker

### OneposWorkerDown
No outbox worker has written a heartbeat for 2 minutes. Emails (invitations, password resets, welcome)
and other events wait in the outbox; nothing is lost.
1. Check the worker process: `pnpm --filter @1pos/workers start` locally, or the worker container.
2. Its log says why it stopped. `WORKER_DATABASE_URL` must be the `onepos_worker` login.
3. Once it runs, `onepos_workers_alive` goes back to 1 or more, and the backlog drains by itself.

### OneposOutboxBacklog
The oldest undelivered event is more than 10 minutes old. Either the worker is down (see above), or it is
failing and retrying: `onepos_worker_outbox_events_total{outcome="retried"}` grows, and the worker log shows
`outbox event will retry` with the error. Fix the cause (usually the mail provider); retries continue by
themselves with backoff.

### Outbox dead letters
`OneposOutboxDeadLetters`: events used up their retries (10) and are `DEAD`. They are kept, never dropped.
1. List them (as the worker login):
   `pnpm --filter @1pos/workers build`, then
   `pnpm --filter @1pos/workers dead-letters list [--topic <topic>]`.
   The list shows the topic, the business id, attempts and the last error, never the payload.
2. Fix the cause first. A replay of an unfixed failure just goes DEAD again after its retries.
3. Replay:
   `pnpm --filter @1pos/workers dead-letters replay <event-id>... --reason "mail provider restored"`,
   or `replay --all [--topic <topic>] --reason "..."`.
   Each replay gets a fresh set of attempts and writes a platform audit row
   (`platform.outbox.replay`, with the actor and the reason). `--actor` defaults to your OS user name.
4. Delivery is at least once. A handler that failed after its outside call (for example, the mail was
   sent but the reply timed out) repeats that call on replay. Today's only handler sends the welcome email,
   so at worst an owner gets it twice. Check each new handler before replaying its topic.

### OneposWorkerLoopErrors
The worker loop keeps failing: it cannot claim events, usually because the database is unreachable or the
worker's role lost a grant after a migration. The worker log says `worker loop error` with the database error.

### OneposWebhookDeliveriesDead
A business's webhook endpoint (ADR-0019) failed every attempt for a delivery: 8 attempts over about a day
(30 s doubling to a 6 h cap), and the delivery is `DEAD`. This is usually the business's receiver (down,
answering 4xx/5xx, too slow past `WEBHOOK_TIMEOUT_MS`, or not on a public https address), not ours.
1. The worker log says `webhook delivery dead` with the delivery and endpoint ids and the last status code.
2. Nothing is lost: the delivery row keeps the event (ids only). The business sees it on Subscription →
   Integrations with its last error, and presses "Send again" once their receiver is fixed (audited).
3. Many endpoints failing at once points at us instead: check outbound network from the worker host and
   that `WEBHOOK_SIGNING_KEY` is the same on the API and the worker (a mismatch makes every receiver
   reject the signature).

## Operations

### OneposVarianceAwaitingApproval
A shift closed with a cash variance has waited more than 2 days for a manager's approval. This is not a
system fault: remind the branch manager (variance approval needs a different user than the cashier).

### OneposRefundRefusals
Many returns or voids were refused in an hour: `sum by (code) (increase(onepos_refund_refusals_total[1h]))`.
`FORBIDDEN` or `NOT_SESSION_OWNER` in bulk can mean someone probing; `INSUFFICIENT_CASH` or
`VOID_OUTSIDE_SESSION` usually means training. Check the audit log of the branch concerned.

### OneposInventoryConflicts
Many stock documents were refused in an hour (over-receipt, a transfer received twice, a stale count).
Usually two people working the same document. `sum by (document, code) (...)` shows which kind.

### OneposProvisioningFailures
A business sign-up failed with a server error. The sign-up is atomic, so nothing half-made remains. Find the
`correlationId` in the API log around the time, fix the cause, and tell the person to sign up again.

## Platform

### OneposRedisDown
Redis does not answer. Rate limits count per API instance until it is back (still limited, sign-in still
works). Restore Redis; nothing else needs doing. Production requires `REDIS_URL`.

### OneposRateLimitFallback
Some rate-limit hits were counted in-process because a Redis command failed or timed out (300 ms). Short
blips are harmless. If it repeats, check Redis latency and the network between the API and Redis.

### OneposBusinessGaugesSlow
`platform_metrics()` takes more than 2 s. It counts through partial indexes (migration 0046), so check
for table bloat (`VACUUM`) or a missing index after a schema change. The query has a 3 s client timeout
and runs at most every 10 s per replica, so it cannot pile up.

## Backups

### OneposBackupMissing
No backup has succeeded in 26 hours (`onepos_backup_last_success_timestamp_seconds`; 0 means never).
Every success is a `backup_runs` row written by `backup run`; failures write nothing and exit non-zero.
1. Look at the scheduler's last run of `pnpm backup run` and its output. Common causes: the backup login's
   password rotated, `BACKUP_DIR` full or unmounted, pg_dump older than the server, `BACKUP_AGE_RECIPIENT` unset.
2. Run it by hand (`pnpm backup run`) and watch it finish; the gauge moves at the next scrape.
3. If backups cannot be made today, say so in the pilot channel: the recovery point grows until one succeeds.
Details: [backup-restore.md](backup-restore.md).

### OneposRestoreDrillOverdue
No restore drill has passed in 35 days (`onepos_restore_drill_last_success_timestamp_seconds`). A backup
that has never been restored is not known to work. Run `pnpm drill:restore` on the drill host
([backup-restore.md](backup-restore.md#the-restore-drill)) and file its report; a failed drill is a
critical defect of the backup, not of the drill.
