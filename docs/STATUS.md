# 1POS — Status

_Last updated: 2026-10-15 (session 1)_

## Current phase
**Phase 1 — Platform foundation: IN PROGRESS.** Slices done and verified: 1 identity/onboarding/RBAC read side · 2 organization (legal entities, branches, registers, terminals) · 3 catalog & pricing · 4 team management (invitations, roles, anti-escalation) · 5 entitlements, idempotency, outbox + worker.
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
| `pnpm test` | **43 passed** (money 15, config 6, validation 5, api 15, workers 2) |
| `pnpm test:integration` | database **14**, api **77** (auth 20 + org 12 + catalog 16 + team 14 + billing 8 + reliability 7), workers **8** → **99 passed** (Postgres 18, runtime role `onepos_app`) |
| worker binary | `node dist/main.js` boots against dev DB (`worker started`) |

Billing/reliability/worker coverage: trial → full access; lapsed trial / past-due after grace / canceled → 402 read-only with data still readable; tenants can't change subscriptions (grants); plan caps incl. 6 parallel creations vs cap 2 → exactly 2; seat cap counts pending invites. Idempotent replay (same body, `Idempotent-Replayed`), 5 concurrent duplicates → 1 creation, key reuse with other payload/user → 422, failed attempts not recorded, keys tenant-scoped. Outbox events written atomically (none on rollback); worker delivers once per event in the event tenant's RLS context, backoff → DEAD, expired lease reclaimed and late ack refused, 3 competing workers never double-process, cross-tenant payload can't leak (RLS).

Team coverage (apps/api/test/integration/team.test.ts): invite → accept as new user (signed in, scoped grants) / as existing user (email must match); tokens one-time; duplicate pending / already-member refused; revoked & expired unusable; garbage token generic 404; branch admin invites only within own branch; admin can't mint owners or create roles with permissions they lack; system roles read-only; admin can't suspend/demote owner; cashier can't invite; role change/suspend/reactivate/remove take effect on next request; last active owner protected (LAST_OWNER); custom role lifecycle; cross-tenant team attacks all 404.

Catalog coverage (apps/api/test/integration/catalog.test.ts): signup seeds UoMs/tax categories/default price list; product+variants+barcodes+prices; search by name/SKU/barcode with LIKE-wildcard escaping; cursor pagination; SKU/barcode uniqueness + reuse after archive; weighted/service/last-variant rules; money must be decimal strings ≤ 4 dp; acyclic category tree; lookup by barcode/SKU with branch price list override and default fallback; unpriced → null; scheduled prices + backdating refused; price history append-only (grant + trigger); single default list; cashier read-only; cross-tenant read/modify/extend/price/lookup/reference attempts all 404; codes unique per tenant only.

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
Phase 1 slice 6 — **admin-web** (`apps/admin-web`, Next.js 16 App Router + Tailwind 4 + shadcn/ui, port 3320): sign-up/sign-in, tenant picker, onboarding (legal entity → branch → register), team (invite, roles), catalog (products, prices), subscription view. Auth via httpOnly cookies set by Next route handlers (BFF) — tokens never in JS-readable storage; API base URL server-side only. Load the `impeccable`/`ui-ux-pro-max` skill for design. Real loading/empty/error states; every control functional or clearly marked "planned". Playwright smoke test.
Then **Phase 1 exit review**: cross-tenant suite completeness per table, OpenAPI generation, pino/OTel logging, docs refresh → declare Phase 1 exit criterion met (or list gaps).
