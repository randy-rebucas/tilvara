# 1POS — guidance for Claude sessions

**Start every session by reading `docs/STATUS.md`** (current phase, what's verified, next task), then `docs/BACKLOG.md`. The full product spec is `docs/SPEC.md` (copy of the user's master prompt) — it is the source of truth for requirements.

## Working rules (from the spec)
- Work phase by phase (Inspect → Plan → Implement → Validate → Review → Document → Report). Don't start a later phase while an earlier phase has open critical defects.
- A feature is done only when schema, domain rules, API, authorization, failure handling, and automated tests all work. Never report UI-only or mocked work as complete; name dev adapters `Dev*`/`Fake*`.
- Never claim tests passed unless they were run in this session; quote the command.
- Never claim BIR accreditation/compliance. Production invoice issuance stays disabled until the compliance gate in `docs/compliance/` is cleared.
- Money/quantities: `@1pos/money` only, decimal strings on the wire, never JS numbers.
- Tenant data: only inside `withTenant(pool, tenantId, fn)` from `@1pos/database`; tenant id from the server-side session only. Every new tenant table needs: `tenant_id`, `UNIQUE(tenant_id,id)`, composite FKs, `ENABLE`+`FORCE` RLS policy, grants for `onepos_app`, and a case in the cross-tenant test suite.
- Financial/inventory/audit tables are append-only (trigger `app_forbid_mutation`); corrections are new rows.
- NestJS: every constructor dependency uses explicit `@Inject(Token)` — Vitest does not emit decorator metadata (SWC native binding fails on this machine, so it was removed).
- Drizzle wraps pg errors (`Failed query: …`); the Postgres error is on `err.cause`.
- Update `docs/STATUS.md` + `docs/BACKLOG.md` at the end of each session.

## Commands (run from repo root, PowerShell or bash)
- `pnpm db:up` — Postgres 18 on 127.0.0.1:55460, Redis 7 on 127.0.0.1:56400 (compose project `onepos`)
- `pnpm build` · `pnpm typecheck` · `pnpm lint` · `pnpm test` (unit) · `pnpm test:integration` (needs db:up; migrates `onepos_test` automatically)
- `pnpm db:generate` (drizzle-kit DDL) · custom SQL: `pnpm --filter @1pos/database exec drizzle-kit generate --custom --name=<name>` · `pnpm db:migrate` (needs `pnpm build` first)
- `pnpm dev:api` → http://127.0.0.1:4320/v1/health/ready

## Environment gotchas (this Windows machine)
- npm/pnpm network is very slow (installs take 10–25 min) — run `pnpm install` in the background.
- PowerShell 5.1: no `&&`; `Set-Content` mangles UTF-8 — edit files with the editor tools.
- Rust/cargo not installed → Tauri work (Phase 5) blocked until rustup is installed.
- DB roles: `onepos_migrator` (owner, migrations), `onepos_app` (runtime, RLS enforced), `onepos_readonly`, `onepos_platform` (NOLOGIN, BYPASSRLS, owns SECURITY DEFINER platform functions). Created by `infra/docker/postgres/init/01-roles.sql` only on a fresh volume (`docker compose down -v` to recreate dev DB).
