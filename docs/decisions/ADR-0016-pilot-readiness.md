# ADR-0016: Pilot and commercial readiness (Phase 6)

- Status: Accepted as the plan (2026-10-17, session 9). Defaults chosen by the engineer. Decisions marked **D1–D6** are the user's to make and are listed at the end.
- Builds on: ADR-0003 (outbox), ADR-0004 (tenant isolation), ADR-0007 (authentication), ADR-0010 (payments), ADR-0015 (offline).

## Context
SPEC Phase 6 asks for:
- performance work
- security hardening
- backup restoration tests
- operational monitoring
- tenant onboarding and support workflows
- documentation
- user acceptance testing (UAT)
- a compliance release review
- a controlled pilot

Its exit criterion is: *selected pilot businesses can operate reliably and reconcile daily transactions.* SPEC §18 lists the 20 release acceptance criteria; §14 the security controls; §16 the metrics and runbooks.

Inspection at the start of the phase (session 9) found the product engine complete and well tested, but nothing yet for running it as a service:
- no Dockerfiles, CI, backups, metrics, alerts or load tests;
- no MFA, password reset or support tooling;
- an in-memory rate limiter (one instance only);
- no audit log reader;
- no tenant data export.
A production boot cannot succeed yet, because the real mailer and payment provider do not exist (by design: the config refuses dev adapters in production).

## Decision: slices, in dependency order
Each slice follows the SPEC process (inspect → plan → implement → validate → review → document → report). A slice is done only with schema, rules, API, authorization, failure handling and automated tests.

### Slice 1 — account security (no outside decisions needed)
- **TOTP MFA (RFC 6238) for privileged accounts.**
  - A member is *privileged* in a tenant when any of their grants holds one of these permissions: `tenant.manage`, `subscription.manage`, `members.manage`, `roles.manage`, `terminals.manage`, `tax.manage`, `accounting.post`, `integrations.manage`. Built-in roles that qualify: owner, admin and accountant. ★
  - Enrolment: secret → confirm with a code → 10 one-time recovery codes, shown once. The secret is encrypted at rest with AES-256-GCM under `MFA_ENCRYPTION_KEY`, so a database dump or backup does not yield it. Codes are stored only as hashes.
  - An enrolled user always passes a second step at sign-in: the login answers `mfaRequired` with a 5-minute challenge, then `POST /v1/auth/mfa/verify` issues the session. A code is accepted once (its time step is remembered). Failed codes count towards the same lockout as passwords.
  - Enforcement: a privileged member whose session is not MFA-verified is refused (`403 MFA_REQUIRED`) on tenant routes once they are enrolled, or once a grace period after their privilege was first seen has run out (`MFA_GRACE_DAYS`, default 7). Enrolment, `/me`, sign-out and switching business stay open. ★
  - The session remembers that it was verified, so refresh keeps it.
- **Auth audit events** (`auth.logout`, `auth.refresh_reuse`, `auth.switch_tenant`, `auth.lockout`, `auth.mfa.*`, `auth.password_reset.*`).
  - Platform events have no tenant, so they go to `audit_logs` with a NULL tenant. The tenant sees only events written in its own tenant.
- **Password reset** through a `Mailer` port: a one-time hashed token valid for 30 minutes. Success revokes every session of the user. The answer is the same whether or not the email exists. Only `DevMailer` exists until D2.
- **Headers**: CSP and HSTS for admin-web (HSTS when `SECURE_COOKIES`). Helmet moves into `configureApp`, so tests see production headers. The API host is configurable (`HOST`, default 127.0.0.1), needed for containers.

### Slice 2 — platform hardening
- **Shared rate limiter.**
  - Redis fixed-window counters (atomic `INCR` + `EXPIRE`), so limits hold across replicas.
  - Buckets per IP, per account (login) and per terminal (sync).
  - Fails open to the in-memory limiter, with a log and a metric, when Redis is unreachable. Refusing every sign-in during a Redis outage would be worse.
- **Least-privilege roles.**
  - New `onepos_worker` login role: it can only claim and complete outbox rows, plus the reads its handlers need.
  - The API keeps `onepos_app`.
- **Supply chain.**
  - `pnpm audit --prod` gate script.
  - A bundle scan proving no server secret or private env name reaches the admin, POS or desktop bundles (THREAT_MODEL T11).
  - Container scanning arrives with slice 7.
- **Security test pass** against THREAT_MODEL T1–T20, with each control mapped to an automated test, or recorded as a gap.

### Slice 3 — operational monitoring
- **Metrics.** Prometheus text format on a separate internal port for the API and the worker (never on the public listener). Covers every SPEC §16 item:
  - checkout count, outcome and latency;
  - payment failures and unresolved intents;
  - duplicate-operation replays and refusals;
  - refund refusals;
  - inventory conflicts;
  - sync queue depth and age, per terminal and for quarantined sales;
  - outbox depth, age and DEAD rows;
  - reconciliation exceptions (shift variances awaiting approval);
  - DB pool health;
  - backup age (slice 4);
  - provisioning failures;
  - billing failures (when billing exists).
- **Business gauges are computed by SECURITY DEFINER functions** owned by `onepos_platform`. They return counts only, never tenant data, so the metrics port cannot leak records.
- **Readiness** also checks Redis and that migrations are at head.
- **Worker heartbeat.** A row per worker; the API exposes it as a gauge.
- **Alert rules** in Prometheus format (`infra/monitoring/alerts.yml`), each linking to a runbook. A test loads the rules and checks that every metric they name is exported.
- **DEAD-letter tool.** A platform CLI to list and replay DEAD outbox rows, audited.
- **OTel traces** wait for D1 (exporter target). The trace-id log mixin is already there.

### Slice 4 — backup and restore
- **Backups.** `infra/backup/` scripts produce a logical backup (`pg_dump -Fc`) encrypted with a public key (age; private key kept off the server). Each run writes a manifest: time, size, SHA-256, migration head and row counts per table.
- **Restore drill** (automated, `pnpm drill:restore`):
  1. decrypt and restore into a fresh scratch database;
  2. verify roles and grants, RLS `ENABLE`+`FORCE` on every tenant table (reusing `rls-catalog` rules), the migration head, and row counts equal to the manifest;
  3. run the traceability audit (`dev-audit.ts`);
  4. start the API on the restored database and run a smoke check.
- **RPO and RTO.** The measured restore time is recorded as RTO evidence.
- **Point-in-time recovery** (WAL) belongs to the hosting choice (D1); with a managed Postgres it is the provider's PITR, and the drill then restores a PITR copy instead.
- A `backup_last_success_timestamp` gauge feeds the alert.

### Slice 5 — performance
- **Target.** Pilot-sized load, stated as a hypothesis until the pilot measures it: 20 tenants × 3 branches × 3 registers, 5,000 items each, 30 checkouts/minute per busy register.
  - Targets: checkout p95 < 500 ms and p99 < 1 s, lookup p95 < 150 ms, sync of 50 sales < 5 s, reports for 31 days < 3 s — on the staging size of D1.
  - Without D1 the numbers are measured on this machine and labelled as such. No performance claim is made beyond what was measured.
- **Dataset.** A seeded dataset generator (`apps/api/test/load/seed.ts`).
- **Harness.** A load harness in Node (no new runtime): concurrent registers doing lookup → quote → checkout with Idempotency-Keys, plus terminal sync and reports. It reports p50/p95/p99, errors and duplicates (must be 0).
- **Fixes for what it finds.** Already known: the POS menu prices item by item (N queries), and snapshots are not paged.

### Slice 6 — onboarding and support
- **Audit log reader.** `GET /v1/audit-logs` (`audit.read`, filters, cursor) and an admin screen.
- **Support access** (SPEC §13, T14). Platform staff have no standing access.
  - A tenant owner grants **time-limited, purpose-specific** access (read-only by default, at most 72 h) from the admin.
  - Staff act through a support session that is audited on both sides, shown to the tenant, and revocable at once.
  - Needs a `platform_staff` identity, separate from tenant users.
- **Tenant data export.** An owner-requested, asynchronous ZIP of CSVs per table. It is produced by the worker, held in private object storage behind a short-lived signed link (storage adapter: `DevFileStorage` until D1), and audited.
- **Offboarding.** Cancel → read-only (exists) → export → retention hold (records are kept for the legal retention period, never deleted early; see compliance assumptions) → anonymise personal data after it ends. The procedure is a runbook; the anonymisation job comes later.
- **Onboarding.** The overview checklist exists. Add:
  - a "sample data" option for trial tenants, clearly labelled and removable before the first real sale;
  - a first-sale walkthrough.

### Slice 7 — deployment (needs D1, D3)
- Dockerfiles for api, workers and admin-web (non-root, read-only filesystem, health checks), plus a container scan.
- A CI pipeline: lint, typecheck, unit, integration against a Postgres service, build, audit, bundle scan, and E2E on main.
- A staging environment that mirrors production.
- A secrets manager.
- TLS at the edge.
- Encryption at rest (managed DB/storage).
- Migration procedure: expand → deploy → contract; migrations never run by the app at boot.

### Slice 8 — documentation and runbooks
`docs/operations/`:
- incident response;
- backup and recovery;
- database migrations;
- rollback and forward recovery;
- payment reconciliation (once PayMongo exists);
- tenant offboarding;
- support access;
- monitoring and alerts;
- the existing offline terminal recovery.

`docs/compliance/` gains a **privacy** pack for the user's Data Protection Officer: a register of processing activities, a privacy notice draft, retention schedule and breach procedure. These are drafts, **not legal advice**.

### Slice 9 — UAT, compliance release review, pilot (needs D4–D6)
- **UAT scripts** per pilot persona (retail counter, restaurant floor, manager close, owner month-end), written in plain words, with expected results and a sign-off sheet.
- **Compliance release review**: a checklist against `docs/compliance/` and SPEC §18 item 13.
  - Invoicing stays **DISABLED**, and 1POS receipts are not invoices. A pilot business must keep issuing its BIR-registered invoices from its current registered system (D5). That needs the tax adviser's confirmation before the pilot.
  - The SC/PWD sign-off (MVP gate #6) and the accountant's answers block any pilot that relies on those features.
- **Pilot.**
  - A runbook for setting up a pilot tenant.
  - A daily reconciliation report per pilot branch: sales = tenders = drawer, stock movements traced, books balanced, sync queue empty, no unresolved payments. It is built on the existing reports and audit.
  - A pilot log of defects and support requests.
  - Exit is judged on real pilot days, not in a session.

## Exit criterion and how it is shown
*Pilot businesses operate reliably and reconcile daily.* Evidence:
1. every SPEC §18 item traced to a test or a signed document, or explicitly marked incomplete;
2. N consecutive pilot days (D4 sets N; proposed 14) with a clean daily reconciliation and no critical defect open;
3. a successful restore drill within the pilot window.
Engineering alone cannot meet the exit: it needs D1–D6.

## Decisions for the user
- **D1 Hosting provider and region.** "Cloud" was decided on 2026-10-15; the provider and region are still open (e.g. AWS ap-southeast-1 with RDS + S3 + Secrets Manager, GCP asia-southeast1, or a local PH provider). This decides PITR, encryption at rest, object storage, the secrets manager, the OTel and metrics backend, and the staging size for load targets.
- **D2 Email provider** (e.g. Amazon SES, Postmark, Resend). Invitations, password reset and the welcome email, and the production boot itself, wait for it.
- **D3 Git remote and CI.** On 2026-10-15 the user chose no remote yet, so CI is deferred until they ask; GitHub Actions is assumed when it comes. Until then the gates are run by hand and recorded in STATUS.
- **D4 Pilot businesses**: how many, which kinds (retail/restaurant), which branches and devices, and the pilot length N.
- **D5 Invoicing during the pilot**: confirm with the tax adviser that pilots keep their current registered invoicing and that 1POS receipts carry "not an invoice" (as built).
- **D6 PayMongo**: sandbox keys for Phase 5 slice 6. The pilot is cash-only plus the existing dev provider (refused in production) until then.

★ = engineer's default; the user may revisit.

## As built — slice 1 (session 9)
- **Schema** (0043 DDL, 0044 hand-written):
  - `user_mfa_factors`, `user_mfa_recovery_codes`, `password_reset_tokens`: ENABLE+FORCE RLS, no policy, and no grant to the app or read-only role. They are reached only through `auth_mfa_*` / `auth_password_reset_*` SECURITY DEFINER functions owned by `onepos_platform`. The schema guard lists them as credential tables and asserts there is no access.
  - New columns: `users.privileged_since` (grace start) and `user_sessions.mfa_verified_at` (copied on rotation).
- **TOTP** (`apps/api/src/auth/totp.ts`): `node:crypto` only.
  - RFC 6238/4226 vectors are unit-tested.
  - A ±1 step window. Each step is accepted once (`last_used_step`, an atomic `UPDATE … WHERE last_used_step < step`).
  - Secrets: AES-256-GCM (`v1.` format) under `MFA_ENCRYPTION_KEY`. Production refuses to boot without it; dev derives a key from the JWT secret by HKDF.
  - Recovery codes: 10 × ≈71 bits, stored as SHA-256 only.
- **Sign-in.**
  - With a confirmed factor, a correct password answers `{ mfaRequired, challengeToken }`. The challenge is a 5-minute JWT with `typ=mfa_challenge`, which `verifyAccess` refuses.
  - The password alone resets nothing; wrong codes count towards the same lock as wrong passwords.
  - `POST /v1/auth/mfa/verify` takes a code or a recovery code and issues a session marked as verified.
- **Enforcement** (`AuthGuard`) applies on tenant routes only, so `/me`, sign-out, switching business and the MFA routes stay open:
  - an enrolled member with an unverified session (one that started before enrolment) → `403 MFA_REQUIRED {enrolled:true}`;
  - a privileged member without MFA, after `MFA_GRACE_DAYS` from `privileged_since` → `403 MFA_REQUIRED {enrolled:false, dueAt}`.
  - `/me.mfa` carries `{enabled, sessionVerified, required, dueAt}`.
- **Set-up routes.**
  - `GET /v1/auth/mfa`.
  - `POST …/enroll` re-checks the password; a wrong password counts towards the lock.
  - `POST …/confirm` takes the first code, returns the codes once, and marks the current session.
  - `POST …/disable` needs the password and a code, and is refused while the active business requires MFA.
- **Password reset.**
  - `POST /v1/auth/password-reset/request` always answers 202. The mail is sent after commit and not awaited.
  - Only the newest link works, at most 5 per hour, and each link lasts 30 minutes.
  - `…/confirm` sets the password, unlocks the account and revokes every session. MFA stays on.
- **Audit (platform level, NULL tenant)**: `auth.lockout`, `auth.refresh_reuse`, `auth.mfa.enabled|disabled|recovery_code_used`, `auth.password_reset.requested|completed`.
- **Audit (tenant)**: `auth.logout`, `auth.switch_tenant`, and `auth.login` with `{mfa}`.
- **Headers.**
  - API: helmet moved into `configureApp` (tests see it): `default-src 'none'`, `frame-ancestors 'none'`, HSTS 1 year.
  - Admin: a CSP without nonces (self only, no framing, `form-action 'self'`), HSTS outside dev, and `Permissions-Policy`.
  - The API listen host is `API_HOST`.
- **Admin.**
  - Sign-in gets a code step; the challenge is held in an httpOnly `SameSite=Strict` cookie scoped to `/api/auth`, never in JS.
  - New pages: `/forgot-password`, `/reset-password` and `/security` (QR made in the browser with `uqr`, the set-up key, recovery codes shown once, turn off).
  - Inside the app, a banner with the due date during the grace period, and a redirect to `/security` once blocked. The name in the band links to `/security`.
- **POS.** The code step at sign-in; the challenge is kept in memory like the tokens.
- **Defect found by the screenshots**: an extra icon in the band clipped the last tab at 1440 px. The nav was already 4 px over before this slice. Fixed by `lg:gap-0`, and the E2E now asserts the nav does not overflow.
- **Known gaps (slice 1)**: no nonce-based CSP; no regeneration of recovery codes, so a member who runs out must turn MFA off and on again, which needs a non-privileged role or support; no WebAuthn/passkeys; no admin "reset a member's MFA" (support workflow, slice 6); no mail is delivered in production until D2.

## As built — slice 2 (session 9)
- **Rate limiter** (`infrastructure/rate-limit.store.ts`, `rate-limit.guard.ts`):
  - Counters live in Redis when `REDIS_URL` is set: one atomic Lua `INCR` + `PEXPIRE`, keys `RATE_LIMIT_PREFIX` + `bucket:key`. Production refuses to boot without `REDIS_URL`.
  - ioredis fails fast: no offline queue, 300 ms command timeout. A failed hit is counted in the process instead (`fallbacks` counter, a warning at most once a minute). An outage degrades to per-instance limits; it never removes limits and never refuses sign-in.
  - Boot waits up to 2.5 s for the first connection, so early requests are not split between memory and Redis. That split was found by the first test run and fixed.
  - `@RateLimit(...rules)`: every rule must pass. `by: 'ip' | 'account' | 'terminal'`.
    - Account keys are the SHA-256 of the lowercased email (no personal data in Redis).
    - A rule whose key is missing from the request counts by IP, so it cannot be skipped.
  - New rules:
    - login: 20/min per IP + 10 per 10 min per account;
    - password reset: 5 per 10 min per IP + 3 per hour per account;
    - sync: 600/min per terminal + 3000/min per IP, so forged terminal ids share the address's cap.
  - `TRUST_PROXY_HOPS` (Express "trust proxy") so `req.ip` is right behind a load balancer; the default is 0.
- **Worker role `onepos_worker`** (migration 0045):
  - LOGIN, no BYPASSRLS. It may EXECUTE `outbox_claim/complete/fail` and `platform_purge_expired_idempotency`, which are revoked from `onepos_app`.
  - Read grants: column-level SELECT on `tenants (id, slug, name)`, `tenant_memberships (id, tenant_id, user_id, status)` and `users (id, email, display_name, status)`, all under RLS. No table writes.
  - The role is created outside migrations (`init/01-roles.sql`, `upgrade/2026-10-17-worker-role.sql`). 0045 fails loudly when the role is missing.
  - The worker reads `WORKER_DATABASE_URL`, which is required in production. Each future handler adds explicit grants.
- **Supply chain**:
  - `pnpm security:audit` (`pnpm audit --prod --audit-level high`). It found 7 advisories in Next.js 16.3.5 (1 critical RCE in `next/og`, 1 high SSRF in image optimization, 4 moderate, 1 low); upgraded to 16.3.8, which leaves 0 in production dependencies.
  - Accepted (dev only): esbuild ≤ 0.24.2 inside drizzle-kit (moderate, dev-server advisory; never run).
  - `pnpm security:bundles`: self-test plus a scan of `apps/admin-web/.next/static` and `apps/pos-desktop/dist`.
- **Security pass**: THREAT_MODEL "Control → test map". Gaps named there: T6 webhooks, T14 support access, T15 exports/backups, T18 load, T19 automation (no CI), T21 nonce CSP, T5 approval thresholds.

## As built — slice 3 (session 10)
- **Registry** (`@1pos/observability` `metrics.ts`): Prometheus text format 0.0.4 with node built-ins only (no new dependency). Counters, gauges and histograms with fixed label names; unknown or missing labels throw; at most 2,000 series per metric; collectors run on each scrape, and a failing collector leaves its gauges as they were. Standard process gauges (RSS, heap, start time, event-loop p99).
- **Internal listeners**: `startMetricsServer` serves only `GET|HEAD /metrics`. API on `API_METRICS_PORT` (4329), worker on `WORKER_METRICS_PORT` (4339), both bound to `METRICS_HOST` (127.0.0.1). `0` turns one off (integration tests). The API refuses to boot when its metrics port equals `API_PORT`.
- **API instruments** (`infrastructure/metrics.ts`), mapped to SPEC §16:
  - an Express middleware, first in `configureApp`, records every answered request by **route template** (`/v1/sales/:id`, `unmatched` for 404s), so ids and query strings never become labels. The error filter puts the error code in `res.locals`;
  - from the route and code: `onepos_checkout_total{channel,outcome}` (recorded / replayed / refused / failed) and its duration histogram (replays not timed); `onepos_idempotency_total{outcome}` (replayed, key_reused, duplicate_transaction); `onepos_refund_refusals_total{code}`; `onepos_inventory_conflicts_total{document,code}` (409/422 on stock documents); `onepos_provisioning_total{outcome}` (sign-up);
  - in services: `onepos_payment_outcomes_total{provider,step,outcome}`, `onepos_offline_sales_total{outcome}`, `onepos_db_pool_errors_total`, `onepos_rate_limit_fallbacks_total`;
  - on scrape: pool connections (total/idle/waiting), `onepos_redis_up`, `onepos_schema_migrations_behind`, and the business gauges.
- **Business gauges**: `platform_metrics()` (SECURITY DEFINER, owned by `onepos_platform`, EXECUTE for `onepos_app` only) returns `(metric, label, value)` rows: outbox by status and oldest undelivered age; unresolved payment intents and oldest age; quarantined offline sales and oldest age; tills with an open shift, silent tills (the same 30-minute rule as `GET /v1/sync/terminals`) and longest silence; shifts awaiting variance approval and oldest age; live workers and heartbeat age (+Inf when none). Counts and ages only; the only label values are statuses. Partial indexes (migration 0046) keep each count off the delivered/settled rows. The API queries at most every 10 s (concurrent scrapes share one query; 3 s client timeout); on failure `onepos_db_up` is 0 and the values stay stale.
- **Readiness** (`GET /v1/health/ready`): `checks: { database, migrations, redis }`. 503 when the database is down or the schema is **behind** this build (`platform_migration_head()` vs. the journal shipped in `@1pos/database`; a newer schema is fine for expand/contract deploys). **Redis down does not fail readiness** ★: limits fall back per instance by design (slice 2), and draining every replica would turn a Redis outage into a full one; the answer is `200 {status: "degraded"}` and an alert fires.
- **Worker** (`apps/workers/src/monitoring.ts`): outbox outcomes, batches, loop errors, last loop, pool; a heartbeat row every 15 s through `worker_heartbeat()` (removed on a clean stop by `worker_heartbeat_stop()`, forgotten after a day). `worker_heartbeats` is a platform table: RLS forced, no grants to any login role.
- **DEAD-letter tool**: `pnpm --filter @1pos/workers dead-letters list|replay` as the worker login. `outbox_dead_list()` returns no payload; `outbox_dead_replay(id, actor, reason)` requires both, resets attempts, and writes a NULL-tenant audit row `platform.outbox.replay` (the tenant does not see it).
- **Alerts**: `infra/monitoring/alerts.yml`, 25 rules in 6 groups (critical / warning / info), each with a `runbook_url` into `docs/operations/monitoring.md`. Tests parse the file: every metric a rule names is exported (API test; worker metrics in the worker's unit test), and every runbook link has a section. Mutation-checked: a misspelled metric and a broken anchor both fail.
- **Not in this slice**: backup age (slice 4); billing failures (no billing integration); OTel traces (D1); authentication on the metrics port (it relies on network placement, slice 7).

## As built — slice 4 (session 11)
- **Backup login** `onepos_backup`: LOGIN, BYPASSRLS, `pg_read_all_data`, not superuser, no CREATEDB/CREATEROLE. It owns nothing, holds no table grants, and may run only `platform_record_backup()`. BYPASSRLS is required: under FORCE RLS a dump made by any other login holds no tenant rows, or `pg_dump` refuses. The role is cluster-level: `init/01-roles.sql` creates it on new volumes, and `upgrade/2026-10-17-backup-role.sql` on existing clusters. Migration 0052 fails loudly when the role is missing.
- **`backup_runs`** (migrations 0051 DDL, 0052 hand-written): a platform table, RLS forced, no login-role grants, append-only trigger. It holds one row per successful backup (`BACKUP`) or passed drill (`RESTORE_DRILL`), with file, size, SHA-256, migration count and a `detail` of counts and timings only.
  - `platform_metrics()` gains `backup_last_success_timestamp_seconds` and `restore_drill_last_success_timestamp_seconds` (0 when none).
  - Alerts `OneposBackupMissing` (> 26 h, warning) and `OneposRestoreDrillOverdue` (> 35 days, warning) are in a new `onepos-backups` group. The severity definitions put "selling affected now" alone at critical.
- **Backup** (`@1pos/database` `src/backup/`, CLI `pnpm backup keygen|run|verify`):
  - a REPEATABLE READ READ ONLY transaction exports its snapshot; the exact row count of every table, the catalog posture and the migration head are read in it; `pg_dump -Fc --snapshot` dumps the same snapshot;
  - the archive streams through age (the official TypeScript implementation `age-encryption` 0.3.1, typage, by age's author; X25519 recipients, several allowed) into `<file>.partial`, which is renamed only after `pg_dump` exits 0;
  - then the manifest is written, the run recorded, and local copies pruned (`BACKUP_KEEP_DAYS`, the newest three always kept).
  - `PG_TOOLS_DOCKER` runs the Postgres tools inside a container (this machine has none). The password goes in `PGPASSWORD`, never argv.
- **Catalog posture** (`catalogPosture()`): owners and privilege sets of schemas, relations, sequences, columns and functions (grantors left out; NULL ACL compared as the owner's default), RLS flags, policies, SECURITY DEFINER flag, `proconfig` and a body hash of every function, triggers, default privileges, extensions. Restored = backed up is checked by hash, with an item-by-item diff when it differs. The isolation rules (`isolationProblems()`) moved from `rls-catalog.test.ts` into `src/backup/catalog.ts`, so the schema guard and the drill apply the same allow-lists.
- **Drill** (`pnpm drill:restore`, `infra/backup/drill-restore.mjs`):
  1. file check;
  2. the age header is checked before anything is created, then the backup is decrypted straight into `pg_restore --single-transaction` in `onepos_drill_<time>` (only that name pattern is accepted);
  3. verify head, counts, posture and isolation;
  4. boot the built API as `onepos_app` and wait for ready (the RTO is taken here);
  5. smoke sale through the API;
  6. `dev-audit.ts`;
  7. record (`--no-record` for a real restore), write the report, drop the scratch database (`--keep`).
- **Measured on this machine** (dev DB: 2.7 MB encrypted, 92 tables, 57,181 rows): backup 1.3–2.0 s; drill RTO 18.2 s with a cold API boot, 5.6 s warm (restore 2.4–4.7 s). Not a production figure; D1 staging measures that.
- **Not in this slice**: PITR and off-site storage (D1); scheduling (a cron line in the runbook until slice 7 deploys it); a drill on managed Postgres (described in the runbook).

## As built — slice 5 (session 11)
- **Load kit** (`apps/api/test/load/`). Everything runs in its own database, `onepos_load`, created and migrated by the kit, with API processes started on it (rate limits off).
  - `pnpm load:seed`: the pilot dataset through the real API (20 businesses × 3 branches × 3 registers, 5,000 items each with a barcode and a price, 300 stocked per branch). 100,000 items took 21 min at concurrency 16. Writes retry a 5xx with the same Idempotency-Key, as tills do.
  - `pnpm load:run [--busy 60 --rate 30 --tills 6 --instances 1 --profile]`:
    - busy registers do lookup → quote → checkout, and 5% resend a checkout with the same key, which must replay;
    - tills run in their own processes (`till.ts`, the real `@1pos/pos-offline` engine) and fetch a snapshot, ring up 50 sales, then sync, retrying as the till does;
    - 31-day reports follow.
  - It reports p50/p95/p99 against the targets, plus:
    - stalls: both event loops and the pool queue;
    - a timeline of slow requests;
    - an optional V8 CPU profile taken over the inspector protocol;
    - integrity from the database: every checkout exactly once, no duplicate client transaction, every till sale recorded.
- **Findings and fixes** (all on this machine: 12-thread laptop, Postgres 18 in Docker Desktop, fsync 2–15 ms):
  1. **drizzle rebuilt its relational config for the whole schema in every transaction.** `drizzle(client, { schema })` was called in `transaction()`, at 0.875 ms of CPU per call over ~90 tables; it was 46% of the API's CPU under load. `bindDatabase()` now builds the config and dialect once and binds a cheap database object per transaction (0.034 ms, 25× less; a test guards it). One instance went from 18.4 to 28.8 checkouts/s, and from 103 503s to none.
  2. **Per-item price queries**: `PricingService.effectivePrices()` prices a whole cart or menu in one LATERAL query; `effectivePrice()` uses it. `computeCart` (quote, checkout, bills, offline re-pricing) and the branch menu use it; the menu also uses maps instead of `find()`.
  3. **Snapshot paging**:
     - `GET /v1/terminal/snapshot?pageSize=` (100–5,000) returns the first page and a `nextPage` cursor;
     - `GET /v1/terminal/snapshot/:id/items?after=` returns further pages, priced as of the same `asOf`, for the same terminal only;
     - without `pageSize` the full list comes back as before, so installed tills keep working;
     - the till's transport asks for pages of 1,000 and assembles them;
     - index `product_variants_snapshot_order_idx (tenant_id, sku, id) WHERE archived_at IS NULL` (migration 0053) lets each page stop early (100–280 ms → 70–120 ms a page at 5,000 items).
  4. **Sync retry storm**:
     - Under load a batch of 50 could outlive the till's 15 s timeout. The till then resent it while the first copy was still recording, and the copy queued behind the original's locks. Up to 5 attempts and 28 s were seen.
     - Fix on the server: `SYNC_BATCH_BUDGET_MS` (8,000) stops starting new envelopes after the budget, always delivering at least one.
     - Fix in the engine: envelopes the server did not reach stay due at once (no backoff) when the batch got some answers.
- **Results**: pilot load, 60 busy registers at 30/min (30 checkouts/s offered), 6 tills, 120 s:
  - **2 API instances**:
    - throughput 30.0/s;
    - lookup p95 52 ms ✓;
    - checkout p50/p95/p99 80/397/1,568 ms (p95 ✓, p99 ✗);
    - sync of 50 at 4.4 s typical, 5.9 s worst ✗ (target 5 s);
    - every till synced on its first attempt;
    - reports p95 < 0.5 s ✓;
    - integrity ok.
  - **1 API instance**: CPU-bound at ~97%; lookup p95 247 ms ✗; checkout p95 959 ms ✗; tills retried.
  - **Conclusion for slice 7**: run at least 2 API instances for pilot load on hardware of this class.
  - The remaining p99 and sync tails cluster in one or two seconds at a time while both API event loops stay below 50 ms. That points at this machine's database or disk; re-measure on D1 staging before any claim.
- **Seen, not fixed**: `pg` warns "client.query() while already executing" (queries run concurrently on one transaction's client somewhere; pg@9 removes this); a lookup is 14 statements and a 3-line checkout 47; `platform_metrics()` takes ~90 ms on the load database. All are in LEFTOVER.

## As built — ahead of slice 6 (session 10)
Pulled forward from slice 6 because a lost phone would otherwise lock a privileged member out during the pilot:
- **MFA reset by the business** (migration 0050): `POST /v1/members/:id/reset-mfa {reason}` → `auth_mfa_admin_reset()` (SECURITY DEFINER, `onepos_platform`). The business is `app.tenant_id` from `withTenant`, never a parameter; the function re-checks that the actor holds `members.manage` for the whole business and that the target is a member; never oneself; the service also applies the same "could you have granted these roles" rule as suspend/remove. It removes the factor and recovery codes and ends every session; the password stays; a privileged member must enrol again at the next sign-in. Audit: tenant `member.mfa_reset` + platform `auth.mfa.reset` (actor, business, reason). `GET /v1/members/mfa` (`auth_members_mfa()`) tells the member page who has MFA on.
- **MFA reset by support** for an owner: `auth_mfa_support_reset(email, actor, reason, ticket)`, EXECUTE for `onepos_migrator` only (ops credentials), run through `pnpm --filter @1pos/database support mfa-reset …`; platform audit `auth.mfa.support_reset`. Runbook: `docs/operations/support-mfa-reset.md`. This is not the time-limited, tenant-approved support access the slice plans; that is still to build.
- **Audit log reader**: `GET /v1/audit-logs` (tenant-wide `audit.read`; RLS shows only the business's rows, never NULL-tenant platform rows; filters by Manila day, action prefix, person, record; cursor). Admin `/audit`, linked from Team and Books.
