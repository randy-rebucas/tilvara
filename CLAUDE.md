# 1POS — guidance for Claude sessions

**Start every session by reading `docs/STATUS.md`** (current phase, what's verified, next task), then `docs/BACKLOG.md`. The full product spec is `docs/SPEC.md` (copy of the user's master prompt) — it is the source of truth for requirements.

## Working rules (from the spec)
- Work phase by phase (Inspect → Plan → Implement → Validate → Review → Document → Report). Don't start a later phase while an earlier phase has open critical defects.
- A feature is done only when schema, domain rules, API, authorization, failure handling, and automated tests all work. Never report UI-only or mocked work as complete; name dev adapters `Dev*`/`Fake*`.
- Never claim tests passed unless they were run in this session; quote the command.
- Never claim BIR accreditation/compliance. Production invoice issuance stays disabled until the compliance gate in `docs/compliance/` is cleared.
- Money/quantities: `@1pos/money` only, decimal strings on the wire, never JS numbers.
- New tenant tables are policed automatically: `rls-catalog.test.ts` (schema rules) and `isolation.test.ts` (needs fixture rows in every tenant table; every new `:id` route needs a case in its attack matrix).
- Tenant data: only inside `withTenant(pool, tenantId, fn)` from `@1pos/database`; tenant id from the server-side session only. Every new tenant table needs: `tenant_id`, `UNIQUE(tenant_id,id)`, composite FKs, `ENABLE`+`FORCE` RLS policy, grants for `onepos_app`, and a case in the cross-tenant test suite.
- Tax: compute only via `@1pos/tax` (ADR-0008) fed by the quote path (`TaxService.quote`); VAT status/rounding live in versioned `tax_profiles`. Effective dating uses the DB clock (`apps/api/src/common/clock.ts` / SQL `now()`), never `new Date()`.
- Financial/inventory/audit tables are append-only (trigger `app_forbid_mutation`); corrections are new rows.
- NestJS: every constructor dependency uses explicit `@Inject(Token)` — Vitest does not emit decorator metadata (SWC native binding fails on this machine, so it was removed).
- Drizzle wraps pg errors (`Failed query: …`); the Postgres error is on `err.cause`.
- Update `docs/STATUS.md` + `docs/BACKLOG.md` at the end of each session.

## Commands (run from repo root, PowerShell or bash)
- `pnpm db:up` — Postgres 18 on 127.0.0.1:55460, Redis 7 on 127.0.0.1:56400 (compose project `onepos`)
- `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` (unit) · `pnpm test:integration` (needs db:up; migrates `onepos_test` automatically)
- `pnpm db:generate` (drizzle-kit DDL) · custom SQL: `pnpm --filter @1pos/database exec drizzle-kit generate --custom --name=<name>` · `pnpm db:migrate` (needs `pnpm build` first)
- `pnpm dev:api` → http://127.0.0.1:4320/v1/health/ready
- Admin web: `pnpm dev:web` → http://127.0.0.1:3320 (needs API on 4320). BFF only: browser → `/api/auth/*` + `/api/v1/*` proxy (CSRF header `x-onepos-request: 1`); tokens live in httpOnly cookies, never in JS. All copy via `src/i18n/messages.ts` (EN + FIL). Follow DESIGN.md (Salapi world) for UI changes. Next.js 16: read `node_modules/next/dist/docs` before using unfamiliar APIs (middleware is `proxy.ts`).
- E2E: start API (`RATE_LIMITS_ENABLED=false` locally) + `next start`, then `pnpm test:e2e:web` (headless Edge via CDP; screenshots → `.impeccable/review/`).
- Worker: `pnpm --filter @1pos/workers build` then `pnpm --filter @1pos/workers start` (outbox processor)
- OpenAPI: `pnpm build` then `pnpm --filter @1pos/api openapi` → `docs/api/openapi.json` (a unit test fails if it drifts from the routes).
- Design review captures: with API + web running, `node apps/admin-web/e2e/review.mjs` → `.impeccable/review/screens/` (both E2E scripts share `e2e/cdp.mjs`).
- Logging: `@1pos/observability` (`createLogger`, `withLogContext`, `enrichLogContext`); `LOG_LEVEL` env. Never log bodies, query strings, headers or tokens.
- New tenant-data writes go through `TenantService.mutate()` (subscription write check + idempotency + 409 mapping); emit side effects with `emitEvent()` in the same tx, never call external services inside a DB transaction.
- Drizzle `db.execute()` returns timestamps as strings (raw `client.query` returns Dates).

## Environment gotchas (this Windows machine)
- npm/pnpm network is very slow (installs take 10–25 min) — run `pnpm install` in the background.
- PowerShell 5.1: no `&&`; `Set-Content` mangles UTF-8 — edit files with the editor tools.
- Rust/cargo not installed → Tauri work (Phase 5) blocked until rustup is installed.
- DB roles: `onepos_migrator` (owner, migrations), `onepos_app` (runtime, RLS enforced), `onepos_readonly`, `onepos_platform` (NOLOGIN, BYPASSRLS, owns SECURITY DEFINER platform functions). Created by `infra/docker/postgres/init/01-roles.sql` only on a fresh volume (`docker compose down -v` to recreate dev DB).
