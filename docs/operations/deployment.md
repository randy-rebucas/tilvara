# Runbook: deployment

For: whoever builds, configures and releases Tilvara's servers and tills. It describes what runs, what
each piece needs, and the order a release goes out in, for the system as built on 2026-10-31.

**Production cannot boot yet, by design.** `@1pos/config` refuses to start the API or the worker with
`NODE_ENV=production` while any development adapter is selected, and three of them have no production
alternative yet:

| Setting | Only value today | Waits on |
|---|---|---|
| `MAILER_DRIVER` | `dev` (logs mail) | D2, email provider |
| `FILE_STORAGE_DRIVER` | `dev` (a local folder) | D1, object storage |
| `PAYMENT_PROVIDER` | `dev` (simulator) | D6, PayMongo card/QR adapter |

A staging environment on Render is described in [render.md](render.md) (Blueprint `render.yaml`).
Hosting for production (D1) and the deployment slice (ADR-0016 slice 7: images, staging, secret manager, TLS) are also
open. Until they close, this runbook gives the parts that are fixed by the code, and states the rest as
requirements. Do not work around the boot checks; they are what keeps a simulator from taking real money
or a laptop folder from holding business exports.

## 1. What runs

| Piece | Source | Built with | Runs as | Listens on |
|---|---|---|---|---|
| API | `apps/api` | `pnpm build` → `apps/api/dist/main.js` | `node dist/main.js`, DB login `onepos_app` | `API_HOST:API_PORT` (public, behind the edge); `METRICS_HOST:API_METRICS_PORT` (internal) |
| Worker | `apps/workers` | `pnpm build` → `apps/workers/dist/main.js` | `node dist/main.js`, DB login `onepos_worker` | `METRICS_HOST:WORKER_METRICS_PORT` only (internal) |
| Admin web | `apps/admin-web` | `next build` | `next start`, no DB login (talks to the API only) | port 3320 by default (behind the edge) |
| Browser till | `apps/pos-desktop` | `vite build` → `dist/` (static files) | any static server | — |
| Desktop till | `apps/pos-desktop/src-tauri` | `pnpm tauri build` (NSIS installer) | the shop's Windows PC | — |
| Postgres 18 | managed service (D1) | — | — | private network only |
| Redis 7 | managed service (D1) | — | — | private network only |

Postgres holds everything: data, the outbox (ADR-0003), idempotency keys. Redis holds only rate-limit
counters; the API keeps working without it (readiness reports `degraded`, `OneposRedisDown` fires).

Instances:
- **API**: stateless, run two or more behind the load balancer. Sessions are in Postgres, rate limits in
  Redis (`REDIS_URL` is required in production for that reason).
- **Worker**: one or more. Workers claim outbox rows with leases, and the hourly billing pass takes an
  advisory lock, so a second worker is safe. Must be on the same file storage as the API.
- **Admin web**: stateless (tokens are in the visitor's cookies); two or more.

Node 24 and pnpm 10 (`package.json` `engines`, `packageManager`).

## 2. Network

```
           Internet
              │ TLS
        ┌─────▼──────┐
        │ edge / LB  │  app.<domain>, *.<SHOP_DOMAIN>, api.<domain>, till.<domain>
        └──┬───────┬─┘
   admin   │       │  /v1
   ┌───────▼──┐  ┌─▼──────┐        ┌────────┐
   │ admin web├──► API    ├────────► Postgres│
   └──────────┘  └─┬──────┘        └───▲────┘
                   │ Redis             │
                   ▼                ┌──┴─────┐
                 Redis              │ worker │
                                    └────────┘
   Prometheus (private) ──► API :4329, worker :4339
```

- Public: the edge only. It terminates TLS and forwards to the admin web, the API and the browser till.
- The API is reached by the admin's **server** (`ONEPOS_API_URL`), by tills directly, by API-key clients
  and by PayMongo's webhook. Browsers never call the API from admin pages: they go through the admin's
  BFF proxy.
- The browser till calls `/v1/...` on its own origin: serve its static files on a host whose `/v1` the
  edge routes to the API.
- Private: Postgres, Redis, the metrics ports. The database has no public address and is reachable only
  from the app network and the ops bastion (production-access.md section 4).
- The worker accepts no traffic. It makes outbound HTTPS calls for webhooks and PayMongo.

Proxy hop counts must match the real chain, or per-IP rate limits either trust spoofed addresses or put
everyone in one bucket:
- API `TRUST_PROXY_HOPS`: proxies in front of the API (one load balancer: 1).
- Admin `ONEPOS_TRUST_PROXY_HOPS`: proxies in front of the admin.

Shop addresses (`<slug>.<domain>`, session 40) need wildcard DNS and a wildcard certificate for
`*.<ONEPOS_SHOP_DOMAIN>` pointing at the admin, and the admin's own URL on a host that is not one of them.

## 3. Database set-up (once per cluster)

Roles belong to the cluster, not to migrations. On a new production cluster, as the provider's admin
login:

1. Create the roles of `infra/docker/postgres/init/01-roles.sql` **with passwords from the secret
   manager**, never the `_dev` ones in that file: `onepos_migrator`, `onepos_app`, `onepos_worker`,
   `onepos_backup` (LOGIN); `onepos_readonly`, `onepos_platform` (NOLOGIN); the grants it makes
   (`onepos_platform` to the migrator, `pg_read_all_data` to the backup login).
   - A managed service may not allow `BYPASSRLS` from its admin login; check before choosing it (D1).
     `onepos_platform` and `onepos_backup` need it.
2. Create the database `onepos` owned by `onepos_migrator`; in it, make `public` owned by the migrator,
   revoke it from `PUBLIC`, grant `USAGE` to `onepos_app, onepos_worker, onepos_readonly` (the three
   schema lines of the init script). Do not create `onepos_test` in production.
3. Apply migrations (section 6, step 3). They create the tables, RLS policies, grants and the platform
   functions.
4. Check posture: `pnpm drill:restore` against a copy proves RLS and grants on a restored database;
   on the live one, readiness answers `checks.migrations: up` and the traceability audit is clean.

The upgrade scripts in `infra/docker/postgres/upgrade/` are for clusters created before those roles
existed; a new cluster from the current init script does not need them.

## 4. Configuration

All settings are environment variables, validated at boot by `@1pos/config` (`loadServerEnv`,
`loadWorkerEnv`). A process with a missing or development-only value stops and lists every problem; it
never prints values. `.env.example` documents each one. In production they come from the secret manager
(D1), never from a `.env` file.

**Start commands**: the `pnpm start` scripts of the API and worker pass `--env-file=../../.env` and fail
when that file is absent. In production run the entry point directly:

```
node apps/api/dist/main.js
node apps/workers/dist/main.js
pnpm --filter @1pos/admin-web exec next start -p 3320 -H 0.0.0.0
```

(`next start` in the package script binds 127.0.0.1; a container needs `0.0.0.0`.)

### API

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `onepos_app` login, TLS to the database |
| `REDIS_URL` | required |
| `API_HOST` / `API_PORT` | `0.0.0.0` / 4320 in a container |
| `TRUST_PROXY_HOPS` | number of proxies in front (section 2) |
| `JWT_ACCESS_SECRET` | 32+ random bytes; no `dev-only`/`change-me` |
| `MFA_ENCRYPTION_KEY` | 32 random bytes, base64 (44 chars). Losing it makes every authenticator enrolment unreadable; rotate only with `mfa-rekey` (security-incident.md 2.5.1) |
| `BFF_SHARED_SECRET` | 32+ random characters, = admin `ONEPOS_BFF_SECRET` |
| `WEBHOOK_SIGNING_KEY` | 32+ random characters, same value on the worker. Changing it changes every webhook endpoint's secret |
| `WEBHOOK_ALLOW_INSECURE` | unset or `false` |
| `RATE_LIMITS_ENABLED` | `true` (the default; `false` is refused) |
| `CORS_ORIGINS` | the admin and browser-till origins, plus `http://tauri.localhost` for desktop tills |
| `APP_PUBLIC_URL` | the admin's address (emailed links) |
| `API_PUBLIC_URL` | the API's public address |
| `SHOP_DOMAIN` | = admin `ONEPOS_SHOP_DOMAIN`, if shop addresses are on |
| `BILLING_PROVIDER` | `paymongo`, with `PAYMONGO_SECRET_KEY` (`sk_live_…`) and `PAYMONGO_WEBHOOK_SECRET`; webhook `<API_PUBLIC_URL>/v1/billing/webhooks/paymongo` (billing.md) |
| `MAILER_DRIVER`, `PAYMENT_PROVIDER`, `FILE_STORAGE_DRIVER` | no production value yet (top of this page) |
| `METRICS_HOST` / `API_METRICS_PORT` / `METRICS_TOKEN` | private address / 4329 / 32+ chars, required once `METRICS_HOST` is not loopback |
| `LOG_LEVEL` | `info` |

The rest (token lifetimes, `OFFLINE_WINDOW_HOURS`, `SYNC_BATCH_BUDGET_MS`, `PAYMENT_TIMEOUT_MS`,
`DATA_EXPORT_LINK_SECONDS`, `MFA_GRACE_DAYS`) have production-ready defaults.

### Worker

`NODE_ENV=production`, `DATABASE_URL`, `WORKER_DATABASE_URL` (`onepos_worker`, required),
`WEBHOOK_SIGNING_KEY` (as the API), `BILLING_PROVIDER` + `PAYMONGO_SECRET_KEY` (as the API), the same file
storage as the API, `METRICS_HOST` / `WORKER_METRICS_PORT` / `METRICS_TOKEN`. Optional: `WORKER_ID`
(defaults per process), `OUTBOX_*`, `DATA_EXPORT_RETENTION_DAYS`, `WEBHOOK_TIMEOUT_MS`.

### Admin web (server side only; nothing reaches the browser bundle)

| Variable | Value |
|---|---|
| `ONEPOS_API_URL` | the API as the admin server reaches it, **with `/v1`** |
| `ONEPOS_BFF_SECRET` | = API `BFF_SHARED_SECRET` |
| `ONEPOS_TRUST_PROXY_HOPS` | proxies in front of the admin |
| `ONEPOS_ADMIN_URL`, `ONEPOS_SHOP_DOMAIN` | both, to turn on shop addresses; the admin URL must not be a shop host |
| `ONEPOS_POS_URL` | the browser till's address (the overview's "First sale" button) |
| `ONEPOS_SUPPORT_EMAIL` | shown on read-only and trial notices |

Session cookies are `__Host-`/`__Secure-` under `next start`, so the admin must be served over HTTPS.

### Tills

- Browser till: no runtime settings; serve `apps/pos-desktop/dist/` as in section 2.
- Desktop till: the server address is typed at set-up and saved on the PC. `VITE_API_URL` at build time
  only pre-fills that field: build the production installer with `VITE_API_URL=https://api.<domain>`.

### Secrets that never go on an app host

`DATABASE_MIGRATOR_URL`, `BACKUP_DATABASE_URL`, `BACKUP_AGE_IDENTITY_FILE`, `DRILL_ADMIN_URL`: ops
credentials (production-access.md). `BACKUP_AGE_RECIPIENT` is a public key and may sit with the backup
job.

## 5. Health checks

| Check | Use for | Answers |
|---|---|---|
| `GET /v1/health/live` | process liveness (restart on failure) | always 200 while the process runs |
| `GET /v1/health/ready` | load-balancer readiness | 503 when the database is unreachable or lacks this build's migrations; 200 `degraded` when only Redis is down |
| `GET /metrics` on the metrics port, bearer `METRICS_TOKEN` | Prometheus | — |

Point the load balancer's health check at `/ready`, not `/live`: a new build on an un-migrated database
must stay out of rotation. The worker has no HTTP check; use its metrics (`OneposWorkerDown`).
The alert rules are `infra/monitoring/alerts.yml`, explained in monitoring.md.

On SIGTERM the API closes through Nest's shutdown hooks and the worker finishes its current batch and
stops (`apps/workers/src/main.ts`). A claimed event whose worker dies is reclaimed when its lease
(`OUTBOX_LEASE_SECONDS`) ends.

## 6. Releasing

The order is fixed: **gate → backup → migrate → API → worker → admin → tills**. Migrations are never run
by the app. Each release ships only expand migrations, or a contract whose old shape no running build
reads (database-migrations.md "Expand → deploy → contract"), so the running build keeps working between
steps 3 and 4 and a rollback never needs the schema back.

1. **Gate, on the exact commit** (until CI runs, D3; record the commands and results in the ticket):
   ```
   pnpm install --frozen-lockfile
   pnpm build
   pnpm typecheck
   pnpm lint
   pnpm test
   pnpm test:integration
   pnpm security:audit
   pnpm security:bundles
   ```
   Plus the E2E suites covering what changed (CLAUDE.md lists them) and `pnpm security:pages` against
   staging.
2. **Backup**: `pnpm backup run`, then `pnpm backup verify` (backup-restore.md). Rehearse the migrations
   on a restored copy first when the release has any (database-migrations.md, procedure step 2).
3. **Migrate**, from the ops machine with `DATABASE_MIGRATOR_URL`: `pnpm db:migrate`. A cluster upgrade
   script listed in the release notes runs before it. Verify with
   `SELECT * FROM platform_migration_head();` and the row counts of any back-fill.
4. **API**: replace instances one at a time; each must answer `/v1/health/ready` with
   `checks.migrations: up` before the next. Clients retry writes that got no answer with the same
   Idempotency-Key, so the swap records nothing twice.
5. **Worker**: replace it. Queued events wait in the outbox meanwhile.
6. **Admin web**: replace instances. Signed-in users stay signed in.
7. **Browser till**: publish the new `dist/` (cache-busted file names; serve `index.html` uncached).
8. **Desktop tills**: distribute the installer (section 7). Server releases keep the terminal routes
   compatible with released tills, so tills may lag.
9. **Verify** (incident-response.md section 3 step 5): a sale on a staging-like test business, an
   offline sync, the outbox draining, no new alerts for an hour. Write the release, its migrations and
   the backup used in the ticket and `docs/STATUS.md`.

Keep the previous build's artefacts until the new one has run a full business day. Rolling back:
rollback-recovery.md section 2.

## 7. Desktop till builds

Built on Windows (cargo in `%USERPROFILE%\.cargo\bin`; `CARGO_NET_RETRY=10` for flaky crate downloads):

```
cd apps/pos-desktop
$env:VITE_API_URL = "https://api.<domain>"
pnpm tauri build
```

The NSIS installer lands in `src-tauri/target/release/bundle/nsis/`. Before release: `cargo test` in
`src-tauri` and `pnpm test:e2e:desktop` against staging. Set `version` in `tauri.conf.json` (still
`0.0.0`) to the release.

Not built yet: code signing (unsigned installers trigger SmartScreen on the shop's PC) and automatic
updates (no updater plugin; a new build is installed by hand). Before installing over an older till,
check Admin → Offline → Tills shows nothing waiting for it (rollback-recovery.md section 3).

## 8. Requirements for slice 7 (open)

Kept here until D1/D3 are decided, then replaced by the concrete steps:

- Container images for API, worker and admin web: non-root, read-only filesystem, health checks, a
  container scan in CI.
- CI running the gate of section 6 on every push, and E2E on main (`.github/workflows/ci.yml` exists;
  it has not run, D3).
- A staging environment that mirrors production, with its own account, secrets and database; release
  candidates go there first.
- A secret manager granting each service only its own secrets (production-access.md section 4).
- TLS at the edge; encryption at rest on the database, backups and object storage.
- Managed Postgres with PITR, and the backup job, the off-site copy and the monthly restore drill
  scheduled (backup-restore.md "Managed Postgres").
- The three production adapters of the top table.
- Code signing for the desktop installer.
