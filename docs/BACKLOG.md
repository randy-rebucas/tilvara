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
1. ⬜ Identity: users, argon2id, login, JWT access, rotating refresh sessions, logout/revoke
2. ⬜ Tenant provisioning (`platform_create_tenant` SECURITY DEFINER), owner membership, onboarding endpoint
3. ⬜ Roles/permissions catalog, membership scopes (tenant/legal entity/branch/register), permission guard
4. ⬜ Legal entities + tax profiles (VAT status, TIN, registered name/address, rounding policy)
5. ⬜ Branches, registers, terminals (registration + credential + revoke)
6. ⬜ Catalog: categories, products, variants, barcodes, UoM, tax categories; archive-not-delete
7. ⬜ Price lists + effective-dated prices
8. ⬜ Plans, subscriptions, entitlements (server-enforced guard; grace/read-only behaviour)
9. ⬜ Idempotency middleware + `idempotency_records`; `outbox_events` + worker skeleton
10. ⬜ Audit logging service wired into all sensitive mutations
11. ⬜ `apps/admin-web` (Next.js + Tailwind + shadcn): login, onboarding, org setup, catalog screens
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
