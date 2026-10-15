# 1POS — Status

_Last updated: 2026-10-15 (session 1)_

## Current phase
**Phase 1 — Platform foundation: IN PROGRESS.** Slices done and verified: 1 identity/onboarding/RBAC read side · 2 organization (legal entities, branches, registers, terminals) · 3 catalog & pricing.
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
| `pnpm test:integration` | database **14 passed**, api **48 passed** (auth 20 + org 12 + catalog 16; Postgres 18, runtime role `onepos_app`) |

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
Phase 1 slice 4 — **team management**: invitations (`member_invitations`: email, role assignments with scopes, hashed one-time token, expiry; accept flow creates user if needed + membership; email sending behind a `Mailer` port with a `DevMailer` that logs/stores — no real SMTP yet), role assignment/unassignment endpoints (`members.manage`; cannot remove the last owner; cannot grant a permission you don't hold — no privilege escalation), suspend/remove member, custom roles (`roles.manage`, permissions subset). Cross-tenant + escalation tests.
Then slice 5: plans/subscriptions/entitlements guard + `idempotency_records` middleware + `outbox_events` & worker skeleton; slice 6: admin-web (Next.js + Tailwind + shadcn) for onboarding, org, catalog, team.
