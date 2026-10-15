# 1POS — Status

_Last updated: 2026-10-15 (session 1)_

## Current phase
**Phase 1 — Platform foundation: IN PROGRESS.** Slice 1 (identity, onboarding, RBAC read side) done and verified.
Phase 0 done (commit 159b94e).

## User decisions (2026-10-15)
- **No GitHub remote yet** — keep the repo local; CI deferred. Don't create one until asked.
- **Payment provider: PayMongo** (Phase 2 payment adapter targets PayMongo; dev adapter until keys are provided).
- **Hosting: cloud** (specific provider/region still open — keep Docker images provider-neutral).

## Verified (commands actually run this session, all green)
| Command | Result |
|---|---|
| `pnpm build` / `pnpm typecheck` / `pnpm exec oxlint apps packages` | all ok, lint exit 0 |
| `pnpm test` | money 15, config 5, validation 5, api 15 → **40 passed** |
| `pnpm test:integration` | database **14 passed**, api **20 passed** (Postgres 18, runtime role `onepos_app`) |

API integration coverage (apps/api/test/integration/auth.test.ts): permission catalog = DB seed; atomic signup (dup email/slug → 409, no orphan user on rollback); login auto-select / generic errors / lockout after 5 failures; refresh rotation, reuse revokes the family + its access tokens, concurrent refresh → exactly one wins; logout immediate; forged/malformed tokens; cross-tenant switch/refresh/login denied; members/roles lists tenant-isolated; cashier lacks roles/members; branch-scoped grant ≠ tenant-wide; removed member loses access next request; TENANT_REQUIRED + switch-tenant; audit rows per tenant; signup rate limit.

## What exists
- Packages: `money`, `config`, `validation` (zod contracts, permission catalog, role templates), `database` (Drizzle schema, migrations 0000–0003, `transaction()` / `withTenant()`).
- API (`apps/api`): health, auth (`/v1/auth/signup|login|refresh|logout|switch-tenant`), `/v1/me`, `/v1/members`, `/v1/roles`; global RateLimitGuard (in-memory) + AuthGuard (JWT + DB re-validation via `auth_resolve_context` + grants under RLS); zod pipe; audit helper.
- DB auth design: runtime role has **no** access to password hashes or sessions; everything goes through SECURITY DEFINER `auth_*` functions owned by `onepos_platform` (migration 0003).

## Known gaps in Phase 1 so far
- MFA (TOTP), password reset, invitations, role assignment/custom roles — not built.
- Rate limiter is in-memory (per instance) — needs Redis before multi-replica deploys.
- Lockout reveals account existence via 429 (accepted trade-off, documented in code).
- Node's `crypto.argon2` is used (Node ≥ 24.7); still marked experimental by Node — revisit if it changes.

## Next task (start here)
Phase 1 slice 2 — **organization**: `legal_entities` (TIN, registered name/address, VAT status, invoicing settings placeholder), `tax_profiles`, `branches` (BIR branch code, timezone), `registers`, `terminals` (registration + hashed credential + revoke). Migration with RLS/composite FKs/grants; validate `membership_roles.scope_id` against these tables (trigger); CRUD endpoints with `org.read`/`org.manage`/`terminals.manage`; audit; cross-tenant tests.
Then slice 3: catalog (categories, products, variants, barcodes, UoM, tax categories), price lists; slice 4: invitations + role assignment; slice 5: plans/entitlements, idempotency + outbox; slice 6: admin-web.
