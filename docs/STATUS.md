# 1POS — Status

_Last updated: 2026-10-15 (session 1)_

## Current phase
**Phase 1 — Platform foundation: IN PROGRESS.** Slice 1 (identity, onboarding, RBAC read side) and slice 2 (organization: legal entities, branches, registers, terminals) done and verified.
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
| `pnpm test:integration` | database **14 passed**, api **32 passed** (auth 20 + org 12; Postgres 18, runtime role `onepos_app`) |

Org coverage (apps/api/test/integration/org.test.ts): owner setup with TIN/code normalisation and safe defaults (invoicing DISABLED); TIN/code/BIR-code conflicts; production invoicing mode rejected; input validation; terminal credential shown once, hash unreadable by app role, revocation final (DB trigger); archive ordering; branch-scoped admin sees/manages only its branch; role scope must reference a real node of the same tenant (trigger); cross-tenant list/modify/attach attempts all 404; cashier denied.

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
Phase 1 slice 3 — **catalog & pricing**: `units_of_measure` (+ conversions), `tax_categories` (VATABLE / VAT_EXEMPT / ZERO_RATED codes — just classification; rates come in Phase 2 tax engine), `categories` (tree), `products` + `product_variants` (SKU, track_inventory, sold_by WEIGHT/UNIT, archive-not-delete), `barcodes` (multiple per variant, unique per tenant among active), `price_lists` (+ branch assignment) and effective-dated `product_prices` (NUMERIC(20,4) via @1pos/money, decimal strings on the wire). Endpoints with `catalog.read|manage`, `prices.manage`, barcode lookup endpoint for POS, cross-tenant tests.
Then slice 4: invitations + role assignment/custom roles; slice 5: plans/entitlements, idempotency + outbox; slice 6: admin-web (Next.js).
