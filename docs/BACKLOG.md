# 1POS — Prioritized Backlog (dependency order)

Legend: ✅ done & verified · 🟡 partial · ⬜ not started. Update this file at the end of every session.

## MVP definition
**MVP = single-tenant-usable, multi-tenant-safe retail POS for a PH VAT-registered or non-VAT shop**, online browser-mode POS, cash + one e-payment adapter (dev), cashier sessions with reconciliation, returns/refunds, stock ledger, basic reports. Restaurant, offline, and BIR-live invoicing follow.

### MVP acceptance criteria
1. Two tenants configured side by side; cross-tenant suite green.
2. Owner can configure legal entity (TIN, VAT status), branch, register, products, prices, tax categories.
3. Cashier opens session, scans/searches, sells with cash and split tender; server totals authoritative.
4. Duplicate submit / retry never creates a second sale (tests).
5. Stock movement per sale line; balance = Σ movements (tests).
6. SC/PWD discount computed per verified rules (tests with worked examples signed off by a PH tax professional — **gate**).
7. Return with disposition + refund; original sale untouched; stock only restored on RESTOCK.
8. Session close: expected vs counted cash, variance recorded and approved.
9. Reports: sales summary, by product, by cashier, by tender, refunds/voids, tax summary — each reconciles to source rows (tests).
10. Audit log for every sensitive action; docs reflect reality.

## Phase 0 — Repository & architecture
- ✅ Repo init, pnpm/turbo monorepo, TS strict base config, oxlint, env management (`.env.example`, `@1pos/config` with zod validation)
- ✅ Docker dev infra: Postgres 18 (:55460) with migrator/app/readonly roles, Redis 7 (:56400)
- ✅ Architecture, domain model, data model + ER, API conventions, threat model, testing strategy, ADR-0001..0007
- ✅ Competitor analysis (`docs/research/COMPETITOR_ANALYSIS.md`) + PH compliance assumptions (`docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md`) — web research, items marked verified/partial/UNVERIFIED; needs PH tax professional review
- ✅ `@1pos/money` exact-decimal package + tests
- ✅ `@1pos/database`: migration runner, tenant-scoped transaction helper, `tenants` + `audit_logs` with forced RLS and append-only trigger, integration tests
- ✅ `apps/api` skeleton: env gate, health endpoints, correlation id, error envelope
- ⬜ CI pipeline (GitHub Actions: install, lint, typecheck, unit, integration with Postgres service) — needs a remote repo decision

## Phase 1 — Platform foundation
1. 🟡 Identity: ✅ users, argon2id (node:crypto), login with lockout, JWT access (15 min), rotating refresh with reuse detection, logout/revoke, switch-tenant, `/me`. ⬜ TOTP MFA for privileged roles, ⬜ password reset (needs email adapter), ⬜ Redis-backed rate limiter (in-memory now)
2. ✅ Tenant provisioning via `POST /v1/auth/signup` (user + tenant + 6 system roles + owner membership, atomic)
3. 🟡 Roles/permissions: ✅ catalog (35 codes), role templates, scoped grants (`hasPermission`), global AuthGuard + `@RequirePermissions`, `GET /v1/members`, `GET /v1/roles`. ✅ invitations (hashed one-time token, 7-day expiry, new-user and signed-in accept, DevMailer only), ✅ role assignment, suspend/reactivate/remove, ✅ custom roles, ✅ anti-escalation (grant only what you hold at a covering scope), ✅ last-owner DB guard (deferred constraint trigger), ✅ scope-id validation trigger. ⬜ real email provider (prod boot refuses dev mailer)
4. 🟡 Legal entities ✅ (TIN, VAT status, registered name/address, RDO, price display, rounding, invoicing mode DISABLED/DEV_SERIES only). ⬜ effective-dated `tax_profiles` (moved to Phase 2 with the tax engine — VAT status changes after sales exist must be versioned)
5. ✅ Branches (BIR branch code), registers, terminals (one-time credential, hash not readable by app role, final revocation), archive-not-delete with child checks, scope-aware permissions, role-scope validation trigger. ⬜ terminal authentication for API calls (Phase 2)
6. ✅ Catalog: UoM, tax categories (classification), category tree (acyclic, depth ≤ 5), products (STANDARD/SERVICE, sold by UNIT/WEIGHT), variants (SKU unique per tenant among active, case-insensitive), multiple barcodes, search + cursor pagination, archive-not-delete (frees codes). ⬜ bundles/composites, product images (needs S3 adapter), batch/expiry & serial tracking (Phase 3), UoM conversions (Phase 3)
7. ✅ Price lists (one default, branch assignment), append-only effective-dated prices (scheduled changes, no backdating), POS lookup by barcode/SKU returning the branch price in force (null when unpriced)
8. ✅ Plans (placeholder prices), one subscription per tenant (14-day Growth trial at signup), write-access rule (trial/active/past-due-in-grace = full; else read-only 402, never deletes), plan limits under advisory lock (race-tested), `GET /v1/subscription`. ⬜ PayMongo billing integration (grant `platform_set_subscription` to it), feature flags enforced once restaurant/multi-entity features exist, per-tenant entitlement overrides
9. ✅ Idempotency: `@Idempotent()` + `Idempotency-Key`, record written in the same transaction as the business change (exactly-once incl. concurrent duplicates), 422 on key reuse with different payload/user, failures leave no record. ✅ Outbox: `emitEvent()` in-transaction, `apps/workers` OutboxProcessor (claim with SKIP LOCKED + lease, retries w/ exponential backoff, DEAD after max attempts, lease-expiry reclaim, tenant context from the row), welcome-email handler, idempotency purge. ⬜ dedicated `onepos_worker` DB role, ops metrics for queue depth/age, DEAD-letter admin view
10. ⬜ Audit logging service wired into all sensitive mutations
11. 🟡 `apps/admin-web` (Next.js 16 + Tailwind 4, "Salapi" visual world chosen by the user; hand-built components instead of shadcn): ✅ BFF auth (httpOnly cookies, proxy.ts token refresh, CSRF header + origin check, allow-listed API proxy), sign-up / sign-in / accept-invite / business picker, overview, locations (entities, branches, registers, terminals with one-time key), team (invite with scope, suspend/remove), products (search, cursor paging, quick add), prices (lists, versioned/scheduled prices), subscription (limits as exact-cell meters), EN/FIL catalog, E2E smoke (`pnpm test:e2e:web`, 19 checks). ⬜ product edit/variants UI, custom-role editor, member role editing UI, price-list create UI, Filipino copy review by a native speaker, review captures of sign-up/picker/forms/error states and non-overview pages at 390
12. ⬜ Cross-tenant adversarial suite for all Phase 1 tables/endpoints
13. ⬜ OpenTelemetry + pino structured logging; OpenAPI generation
Exit: multiple tenants configure their businesses without cross-access (suite green).

## Phase 2 — Retail transaction engine
`@1pos/tax` (VAT inclusive/exclusive, exempt, zero-rated, SC/PWD), `@1pos/pricing`, checkout intents, cash tender, payment adapter port + DevPaymentProvider, sales persistence with snapshots, cashier sessions + cash movements + reconciliation, invoice sequences (dev series only, production issuance disabled until compliance gate), receipts, returns/refunds/voids, stock ledger + balances + negative-stock policy, basic reports, `apps/pos-desktop` browser-mode checkout UI, concurrency + idempotency suites.

## Phase 3 — Inventory, purchasing, accounting
Suppliers, POs, goods receipts (partial), supplier returns, transfers (in-transit), counts + variance, weighted-average costing, low-stock alerts, chart of accounts, posting rules, journal entries (balanced, immutable), periods, inventory & GP reports.

## Phase 4 — Restaurant
Menus/versions, modifiers, areas/tables, orders (dine-in/takeaway), tickets + stations + KDS, courses, transfer/merge/split, split bills via allocation, service charge, recipes (versioned) + consumption + waste, restaurant reports.

## Phase 5 — Offline & integrations
Rust/Tauri shell, SQLite local store, durable local outbox, sync protocol, offline cash sales, conflict flags, ESC/POS printer & drawer adapters, real payment provider, EIS/e-invoice adapter (per compliance outcome).

## Phase 6 — Pilot readiness
Load tests, security hardening, backup/restore drill, monitoring/alerts, support workflows, UAT, compliance release review, pilot.

## Phase 7 — Differentiation (validated demand only)
Ecommerce, loyalty, forecasting, replenishment, loss-prevention analytics, multi-branch intelligence.
