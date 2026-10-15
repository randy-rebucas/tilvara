# 1POS — Status

_Last updated: 2026-10-15 (session 1)_

## Current phase
**Phase 0 — Repository & architecture: DONE** (except CI pipeline, deferred until a git remote exists).
**Next: Phase 1 — Platform foundation.**

## Verified this session (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` | 4/4 packages built |
| `pnpm typecheck` | 7/7 tasks ok |
| `pnpm exec oxlint apps packages` | exit 0 |
| `pnpm test` | money 15, config 4, api 4 → **23 passed** |
| `pnpm --filter @1pos/database test:integration` | **14 passed** against Postgres 18 as `onepos_app` (RLS fail-closed, cross-tenant read/update/insert blocked, pool context not leaked after commit or rollback, audit log append-only by grant + trigger incl. owner/TRUNCATE, provisioning validation) |
| `pnpm db:migrate` | dev DB `onepos` migrated |
| `node dist/main.js` + `GET /v1/health/ready` | `{"status":"ok","checks":{"database":"up"}}`; 404 returns standard error envelope with correlation id |

## What exists
- Monorepo: pnpm 10 + turbo; `packages/money`, `packages/config`, `packages/database`, `apps/api`.
- DB: migrations `0000_platform_core` (tenants, audit_logs) + `0001_rls_platform` (RLS helpers, policies, append-only trigger, grants, `platform_create_tenant` SECURITY DEFINER owned by `onepos_platform`).
- Docs: architecture, domain model, data model + ER, API conventions, threat model, testing strategy, ADR-0001..0007, backlog with MVP criteria, competitor analysis, PH compliance assumptions.

## Not done / known gaps
- CI pipeline (no git remote yet — ask the user whether to create a GitHub repo).
- `pnpm test:integration` at root only covers `@1pos/database` (API has no integration tests yet).
- No auth, no admin-web, no POS app yet (Phase 1/2).
- Compliance doc is web research, **not legal advice**; open questions listed there need a PH tax professional.
- Rust not installed → Tauri (Phase 5) blocked.

## Next task (start here)
Phase 1, item 1–3 from `docs/BACKLOG.md`, as one vertical slice:
1. Migration: `users`, `user_sessions`, `tenant_memberships`, `roles`, `permissions`, `role_permissions`, `membership_roles` (+ RLS, composite FKs, grants). Note: `users` is global (not tenant-owned) — design its access via SECURITY DEFINER lookups for login.
2. `apps/api` auth module: register owner + provision tenant (calls `platform_create_tenant`), login (argon2id), JWT access (15 min), rotating refresh tokens with reuse detection, logout. Add `argon2` + `@nestjs/jwt` (or `jose`).
3. Tenant context guard: resolve membership from token → `withTenant()`; permission guard.
4. Tests: unit + API integration (`apps/api/test/integration`) including cross-tenant attempts.
Then continue with legal entities/branches/registers, catalog, prices, admin-web.

## Open decisions for the user (not blocking Phase 1)
- Git remote / CI provider.
- PH payment provider for Phase 2 (PayMongo / Maya / others).
- Hosting region/provider.
