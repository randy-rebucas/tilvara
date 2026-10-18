# Tilvara

Multi-tenant retail and restaurant point-of-sale SaaS for the Philippines. One codebase serves many
businesses; each business's data is isolated by PostgreSQL row-level security.

It is a modular monolith:

| App | What it is | Tech |
|---|---|---|
| `apps/api` | The HTTP API (`/v1`): auth, catalog, prices, sales, inventory, purchasing, books, restaurant, offline sync | NestJS, Drizzle, PostgreSQL |
| `apps/workers` | Background worker: delivers outbox events (welcome mail, data exports), purges expired idempotency keys | Node |
| `apps/admin-web` | The back office for owners and managers | Next.js 16 (App Router), Tailwind |
| `apps/pos-desktop` | The till: in a browser, or as a Windows desktop app that keeps selling cash during an outage | React + Vite; Tauri 2 for desktop |

Shared code lives in `packages/` (`money`, `tax`, `accounting`, `validation`, `database`, `config`,
`observability`, `escpos`, `sync-protocol`, `pos-offline`).

> **Status:** pre-pilot (Phase 6). Tilvara is **not** BIR-accredited, and invoice issuance is disabled.
> Receipts are not official invoices. See [docs/STATUS.md](docs/STATUS.md) for what is built and verified.

---

## Contents
1. [Requirements](#1-requirements)
2. [First-time setup](#2-first-time-setup)
3. [Run the app](#3-run-the-app)
4. [Your first sale, end to end](#4-your-first-sale-end-to-end)
5. [Ports and URLs](#5-ports-and-urls)
6. [Configuration](#6-configuration)
7. [Tests](#7-tests)
8. [Day-to-day commands](#8-day-to-day-commands)
9. [The desktop till (optional)](#9-the-desktop-till-optional)
10. [Troubleshooting](#10-troubleshooting)
11. [Repository map and further reading](#11-repository-map-and-further-reading)

---

## 1. Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24 or newer** | `node -v` |
| pnpm | **10** (repo pins 10.33.0) | `corepack enable` then `corepack prepare pnpm@10.33.0 --activate` |
| Docker | Docker Desktop or Engine with Compose v2 | Runs PostgreSQL 18 and Redis 7 for you |
| A Chromium browser | Chrome or Edge | Only for the E2E scripts (they drive Edge/Chrome through the DevTools protocol) |
| Rust + MSVC build tools | stable | **Only** for the desktop till ([section 9](#9-the-desktop-till-optional)) |

You do **not** need a local PostgreSQL install: database tools run inside the container.

On Windows, both PowerShell and Git Bash work for the commands below. In PowerShell 5.1 use `;`
instead of `&&` to chain commands.

---

## 2. First-time setup

```bash
# 1. Configuration (dev values only; .env is gitignored)
cp .env.example .env            # PowerShell: Copy-Item .env.example .env

# 2. Dependencies (can be slow on some networks; let it finish)
pnpm install

# 3. Database and Redis (compose project "onepos")
pnpm db:up

# 4. Build every package and app (the migration runner and CLIs run from dist/)
pnpm build

# 5. Create the schema in the dev database
pnpm db:migrate
```

What `pnpm db:up` creates on a **fresh** volume (from `infra/docker/postgres/init/01-roles.sql`):

- databases `onepos` (dev) and `onepos_test` (integration tests);
- roles: `onepos_migrator` (owns the schema, runs migrations), `onepos_app` (the API's runtime role,
  row-level security enforced), `onepos_worker` (the worker), `onepos_readonly`, `onepos_backup`, and
  `onepos_platform` (cannot log in; owns the few audited cross-tenant functions);
- the superuser `onepos_owner` (password `onepos_owner_dev`), for ops tasks only.

Check it worked: `pnpm db:migrate` prints `Migrations applied`.

---

## 3. Run the app

Each process in its own terminal, from the repository root. For a full local stack you need the API,
the admin and the till; the worker is optional (welcome mails and data exports).

### API (required)

```bash
pnpm --filter @1pos/api start        # after pnpm build; loads .env
```

Ready when `http://127.0.0.1:4320/v1/health/ready` answers
`{"status":"ok","checks":{"database":"up","migrations":"up","redis":"up"}}` (`degraded` if Redis is
down; a 503 if the database is unreachable or missing migrations).

> `pnpm dev:api` (watch mode) does **not** load `.env`. Either use `start` after a build, as above, or
> export the variables from `.env` into your shell first.

Local tip: rate limits are on by default. If you sign in and out a lot (or run E2E scripts), start the
API with them off: `RATE_LIMITS_ENABLED=false pnpm --filter @1pos/api start`
(PowerShell: `$env:RATE_LIMITS_ENABLED='false'; pnpm --filter @1pos/api start`).

### Admin web (back office)

```bash
pnpm dev:web                         # http://127.0.0.1:3320 (hot reload)
```

or, production-like: `pnpm --filter @1pos/admin-web build` then `pnpm --filter @1pos/admin-web start`.

The admin talks to the API at `http://127.0.0.1:4320/v1` by default. To point it elsewhere set
`ONEPOS_API_URL` (the `/v1` suffix is required), e.g. `ONEPOS_API_URL=http://127.0.0.1:4321/v1`.
Browsers only ever talk to the admin's own `/api/*` routes; tokens stay in httpOnly cookies.

### Till (POS in the browser)

```bash
pnpm dev:pos                         # http://127.0.0.1:3330
```

Vite proxies `/v1` to the API (override with `API_URL=http://host:port`). Tokens are kept in memory
only, so reloading the page signs the cashier out; that is intended.

Production-like: `pnpm --filter @1pos/pos-desktop build`, then in `apps/pos-desktop`:
`npx vite preview --port 3330 --host 127.0.0.1`.

### Worker (optional)

```bash
pnpm --filter @1pos/workers start    # after pnpm build
```

It connects as `onepos_worker` (`WORKER_DATABASE_URL`) and processes the outbox: welcome mails,
data exports (Subscription → Your records), and the hourly clean-up of expired exports.

### Stop everything

Ctrl+C each process, then `pnpm db:down` (keeps the data volume).

---

## 4. Your first sale, end to end

With the API, the admin and the till running:

1. **Sign up** at http://127.0.0.1:3320/sign-up: your name, email, a password of 12+ characters, a
   business name and its web address (slug). This creates the business, its built-in roles and a
   14-day trial, and signs you in as owner.
2. **Overview → Finish setup** guides the rest. In order:
   - **Locations**: add a legal entity (registered name; TIN and VAT status are optional for dev), a
     branch, and a register in that branch.
   - **Products & prices**: add products with a price, *or* use **Try it with sample items** on the
     overview (8 labelled café items, offered to a trial business before its first sale).
3. **Open the till** at http://127.0.0.1:3330 and sign in with the same email and password.
4. **Choose the register**, enter an opening float (e.g. `1000.00`) to open the shift.
5. **Sell**: scan or search an item, take cash, print/show the receipt. Card/QR use the dev payment
   simulator (`PAYMENT_PROVIDER=dev`).
6. Back in the admin: the sale shows under **Reports**, its journal entry under **Books**, the stock
   movement under **Inventory**, and the overview ticks **First sale**. Close the shift in the till to
   count the drawer.

Restaurant flow: in the admin, **Restaurant** sets up kitchen stations, dining areas/tables, modifier
groups and a published menu. The till then has **Tables** (orders, bills, split checks) and the
**Kitchen** display.

### Good to know in development

- **Two-step sign-in**: owners, admins and accountants must turn it on within 7 days
  (`MFA_GRACE_DAYS`); after that, business pages ask for it. Set it up under your name (top right) →
  Your account → Manage two-step sign-in, with any authenticator app.
- **Email is not delivered.** The dev mailer keeps messages in the API's memory and logs only the
  template and a masked recipient. Invitations, password-reset and email-change links therefore cannot
  be opened in dev; they are covered by the integration tests. Test with accounts you create by sign-up.
- **Invoicing is disabled.** Receipts are printed with "THIS IS NOT AN OFFICIAL INVOICE".

---

## 5. Ports and URLs

| What | Address |
|---|---|
| API | http://127.0.0.1:4320/v1 (health: `/v1/health/ready`) |
| API metrics (Prometheus, internal) | http://127.0.0.1:4329/metrics |
| Worker metrics (internal) | http://127.0.0.1:4339/metrics |
| Admin web | http://127.0.0.1:3320 |
| Till (browser) | http://127.0.0.1:3330 |
| PostgreSQL 18 | 127.0.0.1:55460 (`onepos`, `onepos_test`) |
| Redis 7 | 127.0.0.1:56400 |

Connect to the database as the superuser:
`docker exec -it onepos-postgres-1 psql -U onepos_owner -d onepos`.
Remember that tenant tables use forced row-level security, so plain queries as `onepos_app` return
nothing unless a tenant is set.

---

## 6. Configuration

All server settings come from `.env` (template: [.env.example](.env.example)), validated at boot by
`@1pos/config`. Production refuses to start with development placeholders (dev mailer, dev payment
simulator, dev file storage, the sample JWT secret, missing `MFA_ENCRYPTION_KEY`, rate limits off…).

| Setting | Default / dev value | Purpose |
|---|---|---|
| `DATABASE_URL` | `onepos_app@…/onepos` | API runtime connection (RLS enforced) |
| `DATABASE_MIGRATOR_URL` | `onepos_migrator@…/onepos` | Migrations and ops CLIs |
| `WORKER_DATABASE_URL` | `onepos_worker@…/onepos` | The worker's own login |
| `TEST_*_URL` | `…/onepos_test` | Integration tests (never the dev database) |
| `REDIS_URL` | `redis://127.0.0.1:56400/0` | Shared rate-limit counters (falls back to in-process if Redis is down) |
| `API_PORT`, `API_HOST` | `4320`, `127.0.0.1` | API listener (`0.0.0.0` inside a container) |
| `API_METRICS_PORT`, `WORKER_METRICS_PORT`, `METRICS_HOST` | `4329`, `4339`, `127.0.0.1` | Internal `/metrics`; `0` turns off |
| `JWT_ACCESS_SECRET` | dev placeholder | Signs access tokens (32+ random bytes in production) |
| `MFA_ENCRYPTION_KEY` | empty (derived in dev) | Encrypts authenticator secrets; required in production |
| `MFA_GRACE_DAYS` | `7` | Days before two-step sign-in is enforced for privileged roles |
| `RATE_LIMITS_ENABLED` | `true` | Set `false` locally for E2E runs; refused in production |
| `PAYMENT_PROVIDER` | `dev` | Card/QR simulator until the PayMongo adapter exists |
| `APP_PUBLIC_URL` | `http://127.0.0.1:3320` | Base of links in emails |
| `CORS_ORIGINS` | admin + `http://tauri.localhost` | Origins allowed to call the API directly |
| `FILE_STORAGE_DIR` | OS temp folder | Where the dev file storage keeps data exports |
| `LOG_LEVEL` | `info` | JSON logs to stdout |
| `BACKUP_*`, `DRILL_ADMIN_URL`, `PG_TOOLS_DOCKER` | see `.env.example` | Encrypted backups and the restore drill |

Admin-only (set in the admin's environment, not the API's): `ONEPOS_API_URL` (API base, with `/v1`)
and `ONEPOS_POS_URL` (optional: where the till is served, for "Open the till" links).

---

## 7. Tests

| Command | What it runs | Needs |
|---|---|---|
| `pnpm test` | Unit tests of every package | nothing |
| `pnpm test:integration` | API, worker and database suites against `onepos_test` (migrated automatically) | `pnpm db:up` |
| `pnpm typecheck` · `pnpm lint` | TypeScript, oxlint | nothing |
| `pnpm test:db:reset` | Drops and recreates `onepos_test` (it grows with every run) | `pnpm db:up` |

Run the integration suites **one at a time** (as `pnpm test:integration` does); two runs against
`onepos_test` at once interfere with each other.

### End-to-end (browser) suites

They drive a headless Edge/Chrome against **running** servers and save screenshots under
`.impeccable/review/`. Start the API with `RATE_LIMITS_ENABLED=false`, the admin with
`next start` (after building it) and, for till suites, the POS preview. Then for example:

```bash
pnpm test:e2e:web                    # admin smoke
pnpm test:e2e:pos                    # till smoke
pnpm test:e2e:service                # a full restaurant service across admin, floor and kitchen
```

Other suites: `test:e2e:web:security`, `web:backoffice`, `web:reports`, `web:restaurant`,
`web:offline`, `web:onboarding` (needs the worker), `web:account`, `test:e2e:tables`,
`test:e2e:kitchen`, `test:e2e:pos:mfa`, `test:e2e:desktop`. Most accept
`[baseUrl] [screenshotDir] [apiUrl]`.

### Security gates

```bash
pnpm security:audit                  # production dependency advisories (high and above fail)
pnpm security:bundles                # secrets in built client bundles (after building admin + POS)
pnpm security:pages                  # secrets in server-rendered admin pages (API + admin running)
```

---

## 8. Day-to-day commands

| Task | Command |
|---|---|
| New migration from schema changes | edit `packages/database/src/schema/*`, then `pnpm db:generate` |
| Hand-written SQL migration | `pnpm --filter @1pos/database exec drizzle-kit generate --custom --name=<name>` |
| Apply migrations | `pnpm build` then `pnpm db:migrate` |
| Regenerate the OpenAPI document | `pnpm build` then `pnpm --filter @1pos/api openapi` → `docs/api/openapi.json` |
| Format | `pnpm format` |
| Backups / restore drill | `pnpm backup run`, `pnpm backup verify`, `pnpm drill:restore` ([runbook](docs/operations/backup-restore.md)) |
| Load test (separate DB) | `pnpm load:seed` then `pnpm load:run` |
| Support CLI (ops credentials) | `pnpm --filter @1pos/database support <mfa-reset\|account-disable\|account-enable\|staff-add\|staff-list>` |
| Dead outbox events | `pnpm --filter @1pos/workers dead-letters list` |

Never hand-edit `packages/database/drizzle/meta/_journal.json` or reorder migration files
([why](docs/operations/database-migrations.md)).

---

## 9. The desktop till (optional)

The Windows desktop till (Tauri 2) runs the same POS and keeps ringing **cash** sales while the
connection is down, syncing them later.

1. Install Rust (rustup, stable MSVC toolchain) and the Visual Studio C++ build tools. Make sure
   `%USERPROFILE%\.cargo\bin` is on `PATH`.
2. Build: `cd apps/pos-desktop` then `pnpm tauri build --debug --no-bundle`
   → `src-tauri/target/debug/onepos-till.exe`. (If crate downloads fail with 503s, set
   `CARGO_NET_RETRY=10`.)
3. In the admin: **Locations** → the register → **Pair a terminal**. Copy the terminal id and the
   one-time key (shown once).
4. Start the till, enter the server address (`https://…`, or `http://127.0.0.1:4320` on the same PC),
   the terminal id and the key. The key is stored in Windows Credential Manager.

Shell tests: `cargo test` in `apps/pos-desktop/src-tauri`. Recovery procedures:
[offline-terminal-recovery.md](docs/operations/offline-terminal-recovery.md).

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `role "onepos_worker"` / `"onepos_backup"` missing during migrate | The dev volume is older than those roles. Run `infra/docker/postgres/upgrade/2026-10-17-worker-role.sql` and `…-backup-role.sql` as `onepos_owner` once, or reset the volume (below) |
| Want a clean dev database | `docker compose down -v` (**deletes all dev data**), then `pnpm db:up`, `pnpm db:migrate` |
| Health answers 503 `NOT_READY` with `migrations: behind` | The database is older than the build: `pnpm build` then `pnpm db:migrate` |
| API exits at boot listing settings | `.env` is missing a value or has a wrong format; compare with `.env.example` |
| `TOO_MANY_ATTEMPTS` / 429 while testing | Start the API with `RATE_LIMITS_ENABLED=false` |
| Admin shows "Two-step sign-in" and blocks pages | Your role's grace period ended: set up an authenticator (section 4) |
| Till signs out on reload | Intended: tokens live in memory only |
| `EADDRINUSE` on 3320/3330/4320 | An old server is still running; stop it (Windows: `Get-NetTCPConnection -LocalPort 3320` → `Stop-Process`) |
| Integration tests slow or flaky | `pnpm test:db:reset`, and don't run two suites at once |
| A query as `onepos_app` returns no rows | Expected: row-level security needs a tenant (`withTenant` in code, or `SET app.tenant_id`) |

---

## 11. Repository map and further reading

```
apps/        api · workers · admin-web · pos-desktop (+ src-tauri)
packages/    money · tax · accounting · validation · database (schema, migrations, CLIs) · config
             observability · escpos · sync-protocol · pos-offline
infra/       docker (Postgres init/upgrade scripts) · backup (restore drill) · monitoring (alert rules)
scripts/     security (bundle and page scans)
docs/        spec, status, backlog, decisions (ADRs), architecture, operations, compliance, security
```

| Read this | For |
|---|---|
| [docs/STATUS.md](docs/STATUS.md) | Current phase, what is verified, what is next |
| [docs/SPEC.md](docs/SPEC.md) | The product requirements (source of truth) |
| [docs/BACKLOG.md](docs/BACKLOG.md) · [docs/LEFTOVER.md](docs/LEFTOVER.md) | The plan, and open items from finished work |
| [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) | How the pieces fit |
| [docs/decisions/](docs/decisions/) | Architecture decision records (ADRs) |
| [docs/api/openapi.json](docs/api/openapi.json) | The API contract |
| [docs/operations/README.md](docs/operations/README.md) | Runbooks (incidents, backups, migrations, support) |
| [docs/security/THREAT_MODEL.md](docs/security/THREAT_MODEL.md) | Threats and the tests that cover them |
| [docs/compliance/](docs/compliance/) | BIR/tax assumptions and the privacy pack (drafts) |
| [CLAUDE.md](CLAUDE.md) | Engineering rules for contributors (money, tenancy, tax, migrations…) |
