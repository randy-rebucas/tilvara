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
10. 🟡 Audit logging: ✅ every tenant mutation through `TenantService` (catalog, pricing, org, team) + login + onboarding. ⬜ logout/refresh-reuse/switch-tenant/lockout events, audit viewer UI
11. 🟡 `apps/admin-web` (Next.js 16 + Tailwind 4, "Salapi" visual world chosen by the user; hand-built components instead of shadcn): ✅ BFF auth (httpOnly cookies, proxy.ts token refresh, CSRF header + origin check, allow-listed API proxy), sign-up / sign-in / accept-invite / business picker, overview, locations (entities, branches, registers, terminals with one-time key), team (invite with scope, suspend/remove), products (search, cursor paging, quick add), prices (lists, versioned/scheduled prices), subscription (limits as exact-cell meters), EN/FIL catalog, E2E smoke (`pnpm test:e2e:web`, 19 checks). ✅ review capture pass (`e2e/review.mjs`, 15 states × 1440/390) with fixes: translated validation messages (API sends zod issue code+bounds), singular select labels, legible ₱ (system-face `unicode-range` for U+20B1). ⬜ product edit/variants UI, custom-role editor, member role editing UI, price-list create UI, Filipino copy review by a native speaker (enum labels e.g. VAT status still English in FIL), tables at 390px: trailing columns/actions start off-screen inside the scroll container (consider stacked rows)
12. ✅ Cross-tenant adversarial suite: schema guard (`rls-catalog.test.ts`) + API/DB sweep (`isolation.test.ts`, attack matrix = live router's `:id` routes)
13. 🟡 ✅ pino structured logging (`@1pos/observability`, correlation/tenant/user ids, redaction, trace ids when OTel active), ✅ OpenAPI 3.1 generation + drift test. ⬜ OTel SDK + exporter (needs hosting choice), ⬜ typed response schemas
Exit: multiple tenants configure their businesses without cross-access (suite green). **✅ Met 2026-10-15 (session 2).**

## Phase 2 — Retail transaction engine
Slice 1 — tax foundation (session 3): ✅ ADR-0008; ✅ `tax_profiles` (append-only, effective-dated, DB no-backdating trigger, migrated from legal_entities); ✅ `discount_schemes` (SC/PWD seeded, PENDING_PROFESSIONAL_REVIEW); ✅ `@1pos/tax` pure engine (VAT incl/excl, exempt, zero-rated, non-VAT/percentage-tax sales, SC/PWD incl. partial share, no stacking, per-line centavo rounding, snapshots; golden vectors + 2,000 random-cart invariants); ✅ API: tax-profile history/create (`tax.manage`), `GET /v1/discount-schemes`, `POST /v1/tax/quote` (branch price + category + profile in force, cashier scope, `sales.discount` for ordinary discounts); ✅ DB clock is the single clock for effective dating (fixed latent host-clock drift in price stamping).
⬜ Slice 1 leftovers: admin UI for tax profiles (history + "change registration"), SC/PWD sign-off by a PH tax professional (gate #6), 5 % BNPC / NAAC / Solo Parent schemes (rules unverified), invoice-level rounding option, production refusal of PENDING schemes at checkout.
Slice 2 — sales core (session 3): ✅ ADR-0009; ✅ cashier sessions (one open per register, state machine trigger, pay-in/out, close with count, variance approval by a different user), ✅ `POST /v1/sales` (required Idempotency-Key + clientTransactionId, server recompute, stale-total refusal, cash tender with change, gapless per-register numbers, SC/PWD beneficiaries, production refusal of pending schemes, audit + outbox), ✅ append-only stock ledger with trigger-maintained balances + adjustments, ✅ isolation guards extended (5 id routes, 7 smuggling cases, 10 new tables in the sweep), ✅ DB clock 5 s skew allowance (fixed intermittent "not in force" from VM clock steps).
Slice 3 — payments + receipts (session 3): ✅ ADR-0010; ✅ `payment_intents` (state-machine trigger, request-key idempotency, consumed once) + append-only `payment_events`; ✅ provider port + deterministic `DevPaymentProvider` (refused in production by config); ✅ intent → provider call outside any transaction → settle; timeouts become UNKNOWN and are reconciled, never re-authorized (tests prove one charge); ✅ cancel/void of unused intents; ✅ split tender (intents first, cash remainder with change; electronic never gives change); ✅ `GET /v1/sales/:id/receipt` — explicitly NOT an invoice while invoicing is DISABLED, VAT/non-VAT breakdowns, SC/PWD block with ID + signature line. ⬜ PayMongo adapter + webhooks (needs sandbox keys).
Slice 4 — voids/returns (session 3): ✅ ADR-0011; ✅ append-only `sale_returns`/`sale_return_lines`, exact proration (final return takes the remainder), RESTOCK vs DAMAGED, cash refund from an open same-branch drawer (insufficient-cash and stale-refund refusals), void only in the original session and only once, per-sale advisory lock + DB within-sold trigger, own return-number series. ⬜ refunds to card/QR (needs PayMongo), cross-branch returns, receipt for return documents.
Slice 5 — reports (session 3): ✅ sales summary (per local day, sales/returns/net buckets), by product, by cashier, by tender (collected − refunded), tax summary by VAT rate snapshot, SC/PWD sales book (sales and negative return rows), cashier-session report (X-reading style); `reports.read` at branch scope (own session report for cashiers); local-date ranges ≤ 366 days; cross-report reconciliation tests. ⬜ Z-reading with accumulated grand total (fiscal gate G2), exports (CSV/PDF), report UI.
Slice 6 — POS browser checkout (session 3): ✅ `apps/pos-desktop` (React + Vite, browser mode, tokens in memory only): sign-in → business → register picker (`GET /v1/pos/workstations`, works without org.read) → open shift with float → scan/SKU/name search → server-priced cart (`/v1/tax/quote`) with VAT breakdown → SC/PWD per line (name + ID) → cash with quick tenders and change / card-QR via payment intents (UNKNOWN → check payment, cancel) → `POST /v1/sales` with the same key on network retry, stale-total handling → receipt (print via browser) → shift history with manager void/return → close with count; EN/FIL; Salapi adapted for the counter (48px targets). E2E `pnpm test:e2e:pos` 15 checks. Fixes found by it: receipt flagged SC lines as VATable (now E / V/E by actual taxation), shift reopen landed on the close tab, band overflow at 390px. ⬜ CSP response header in production hosting, keyboard shortcuts (F-keys), customer display, barcode scale codes, offline (Phase 5).
Exit review (session 4): ✅ reconciliation suite (multi-register/multi-session day, card sale refunded in cash, local days at UTC±), ✅ failure drills (restart, connection killed mid-checkout, DB unreachable, idle connections dropped, provider timeout, duplicates), ✅ fixes: no crash on dropped DB connections, 503 `SERVICE_UNAVAILABLE` for transient DB errors, close refused over unsettled card/QR payments, `DUPLICATE_TRANSACTION` carries `saleId`, POS keeps keys on 5xx, Sell stays mounted across tabs, POS business picker fixed; ✅ POS review captures (`e2e/review.mjs`) + finish-review fixes. **Exit: ✅ met 2026-10-16.**
⬜ Phase 2 leftovers (non-blocking): `@1pos/pricing` promotions; invoice sequences (dev series only); negative-stock policy (BLOCK/ALLOW_WITH_FLAG) — today sales may go negative and it stays visible; POS phone layout: sticky total + Pay bar; shift history: tender + voided/returned tags; receipt SC block repeats the discount line; a test for one session spanning local midnight (needs clock control); DB-level guard for PAYMENTS_OUTSTANDING (service-level today, race-safe by the session lock).

## Phase 3 — Inventory, purchasing, accounting
Slice 1 — costing (session 4): ✅ ADR-0012; ✅ `unit_cost`/`value` on every movement, `value`/`avg_cost` on balances, computed by the ledger trigger under the balance lock (outbound at average, emptying takes the remainder, returns at sale cost, revaluation of units sold short visible); ✅ legacy rows back-filled at reference cost; ✅ variant-ordered inserts (no deadlocks); ✅ golden vectors + concurrency + DB guards (`costing.test.ts`).
Slice 2 — purchasing (session 4): ✅ suppliers (tenant-wide, codes unique among active, archive guarded by open orders); ✅ purchase orders (state machine trigger, DRAFT-only edits, per-branch numbers); ✅ goods receipts (accepted/rejected with reason, invoice/DR refs, order lock + DB over-receipt guard, unordered and non-stock lines); ✅ supplier returns (average out, credit at receipt cost, DB within-received guard); ✅ isolation (+10 id routes, +10 smuggling cases, 7 tables).
Slice 3 — inventory ops (session 4): ✅ transfers (dispatch → in transit → receive once; shortfall reason; arrive at dispatch cost; same entity only); ✅ counts (variance computed by the trigger at posting; zero variance = no movement); ✅ waste (adjustment kind); ✅ reorder points + low-stock list net of open orders with suggested order; ✅ reports: inventory valuation (= ledger), stock movements (opening + by type = closing), by-product revenue ex VAT / COGS / gross profit; ✅ isolation (+3 id routes, +12 smuggling cases, 5 tables).
Slice 4 — double-entry ledger (session 4): ✅ ADR-0013; ✅ `@1pos/accounting` pure posting rules (13 unit tests); ✅ accounts (default chart seeded per entity + back-filled), periods, append-only journal with deferred balance trigger and closed-period trigger; ✅ every sale, return, receipt, supplier return, adjustment/waste, count, transfer, pay-in/out and drawer variance posts one entry in its own transaction; ✅ manual entries, reversals (once), period close/reopen (reason), trial balance; ✅ GL = evidence for inventory, transit, cash, card clearing, output VAT, revenue, COGS, GRNI (`ledger.test.ts`); ✅ isolation (+2 id routes, +9 smuggling cases, 4 tables).
Slice 5 — admin UI (session 5): ✅ Purchasing (suppliers, POs with lines, approve/cancel/close, receiving with accept/reject per line, receipt page); ✅ Inventory (stock & value checked against the ledger, low stock + reorder points, transfers send/receive with shortfall reason, counts with signed variance, movements report); ✅ Books (journal with two-way source links, manual entry, reversal, trial balance, chart + add account, period close/reopen); ✅ one Idempotency-Key per open form for stock/books documents; ✅ stacked rows below md; ✅ EN/FIL; ✅ E2E smoke 41/41 + review captures 35/35.
Exit review (session 5): ✅ traceability audit both ways (`traceability-audit.ts`: movement → document → entry, entry → document, per-document/branch value ties, transit clearing) — clean on a mixed day, in every drill, and over all 54 dev tenants; mutation-tested; ✅ defect fixed: multi-item stock adjustments had no document (only the first movement traced to the entry) → `stock_adjustments` (0031, back-filled) + `GET /v1/stock/adjustments[/:id]` + admin page; ✅ defect fixed: a posting could land in a month being closed (unlocked check) → period row held FOR SHARE (0032), drill fails on the old trigger; ✅ drills: connection killed mid-receipt, DB unreachable (receipt/transfer/count), double-click receive, 5 concurrent receivers of one transfer, 4 concurrent supplier returns of the last units, mixed receipts/transfers/counts/adjustments on the same items (no deadlock, books = stock), 4 concurrent reversals, close vs posting both orders; ✅ inventory officers see their own branches in `/v1/branches` (admin pickers); ✅ design finish review: 8 fixes applied; ✅ accountant review request written (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`). **Exit: ✅ met 2026-10-16**, with the accountant's answers pending before customers rely on the books.
⬜ Slice 5 leftovers: supplier returns UI (API done); PO draft line editing (API `PATCH`); supplier edit/archive UI; journal filters by date range / source type; admin document pages for sales, returns and cash movements (their entries trace in the API, not yet in the admin UI); `POST /v1/stock/adjustments` accepts but does not require an Idempotency-Key (other stock documents require one) — decide and align; accountant review answers (ADR-0013 questions 1–10); item names on receipts beyond the first 200 products (needs a variants-by-id lookup); low-stock list shows only items at/below the point — no view of all configured reorder points (no GET).
⬜ Phase 3 leftovers: supplier invoices + accounts payable (GRNI → AP, input VAT); low-stock push alerts (outbox event when crossing the reorder point); blind counts (freeze + post later); UoM conversions and purchase units; batch/expiry and serial tracking; landed cost; financial exports (CSV/journal export); accountant review of the default chart and posting policies.

## Phase 4 — Restaurant (plan: ADR-0014)
Slice 1 — recipes + consumption (session 6): ✅ done.
- ✅ `recipe_versions` / `recipe_ingredients` (append-only, effective-dated, no backdating, tracked-ingredient / untracked-item triggers).
- ✅ `CONSUMPTION` movements at checkout (per line and ingredient, costed at average, in the sale's COGS and its one entry).
- ✅ Recipe-made lines are not restockable on return or void.
- ✅ `GET/POST /v1/variants/:id/recipe`.
- ✅ Traceability audit, isolation and `recipes.test.ts` (5).

Slice 2 — menu foundation (session 6): ✅ done.
- ✅ Kitchen stations (code routing, one default per branch), dining areas and tables (same-branch FK, floor position/shape).
- ✅ Modifier groups and options (min/max, priced via an item or free).
- ✅ Menus with versions (draft → published → retired, frozen content, one draft and one published, copy-on-draft, publish under lock).
- ✅ Per-branch settings (menus per order type, service charge config) and 86.
- ✅ POS menu view with branch prices.
- ✅ `menu.test.ts` (7); isolation +22 routes.

⬜ Slice 2 leftovers:
- the built-in `branch_manager` lacks `restaurant.manage` (only owner/admin set up restaurants): add a "restaurant manager" role template or grant it to branch managers;
- the POS menu view prices item by item (N queries), so batch it if menus get large;
- modifier groups are live configuration: edits to min/max apply to published menus immediately (orders snapshot what was chosen).
Slice 3 — orders + kitchen (session 6): ✅ done.
- ✅ Orders (one live per table, state machine trigger, transfer/merge/move/cancel under order-row locks).
- ✅ Items validated against the published menu (modifiers min/max, sold-out, priced/free choices as modifier items), pending edits, frozen once fired.
- ✅ Fire by course → tickets per station.
- ✅ KDS list + statuses + bump.
- ✅ Voids after firing (`sales.void`) with an optional WASTE document (`recordPreparedWaste`).
- ✅ `orders.test.ts` (6) with concurrency drills; isolation +12 routes.

⬜ Slice 3 leftovers:
- KDS push (SSE) instead of polling;
- per-seat views and "fire course N" reminders/timers;
- kitchen printers (Phase 5 device adapters);
- voiding a modifier alone (today: void the item and re-add);
- reprint/recall a ticket;
- order notes per course.
Slice 4 — bills + checks + service charge (session 6): ✅ done.
- ✅ Frozen bill (computeCart + SC/PWD per item + order discount + `serviceCharge()`), reopen before any check.
- ✅ Checks via `SalesService.createFromBill` (exact fraction shares, residual-bucket proration, "pay the rest", last check settles).
- ✅ Retail checkout refactored onto the shared `record()` path.
- ✅ `sale_charges` in sale totals; `SERVICE_CHARGE_PAYABLE` (chart + back-fill + postings); returns give charges back proportionally.
- ✅ Receipt charge line; by-product charges; recipe COGS fix in by-product.
- ✅ `bills.test.ts` (5) incl. the SPEC service cycle and concurrent checks.

⬜ Slice 4 leftovers:
- re-run POS/web E2E after the checkout refactor (blocked this session by a stale API on :4320);
- card/QR checks use the existing intent flow, but no POS UI yet;
- tips;
- a bill print/PDF;
- per-seat split helper (today: allocate the seat's lines);
- adding items after a partial payment (today: a new order once the bill settles);
- returns still prorate each bucket on its own (ADR-0011), unlike checks' residual-bucket proration; align if odd cents show up on partial returns.

Slice 5 — restaurant reports (session 6): ✅ done.
- ✅ `item-performance` (modifiers nested under their item, COGS incl. recipe, margin; Σ = by-product).
- ✅ `ingredient-usage` (expected = recipe + sold; actual adds prepared/other waste and count variance).
- ✅ `kitchen-voids` (stage reached, wasted + WASTE value, by reason and user).
- ✅ `prep-times` (per station: average/median/p90/max fired → ready, wait, pass).
- ✅ `open-orders?day=` (open or billed at the close of a day, paid by then).
- ✅ `service-charge` (per day, distributable ex VAT, cross-checked with the liability).
- ✅ Defect fixed: a check's service-charge base was always prorated, so the bases of an even split added to ₱383.94 against a ₱383.93 bill. The settling check now takes the rest of the base too.
- ✅ `restaurant-reports.test.ts` (8) incl. the ADR §10 invariants; isolation extended.

⬜ Slice 5 leftovers:
- report UI (admin) and CSV export (with slice 6 / the retail report UI);
- prep times by hour or day part and per item;
- open orders: items as they were at the cutoff (today: as attached now);
- free modifiers ("no onions") counts in item performance (no sale line today);
- the DOLE distributable base (ex VAT) is pending the accountant (ADR-0014 §9).
🟡 Slice 6 — UI (session 6):
- ✅ 6a POS table service: floor, order with modifiers/courses, send/serve/void, server-priced subtotal, bill with SC/PWD + discount, checks (rest / even / by item) priced by the new check preview, shared payment panel; receipt prints the service charge; `test:e2e:tables` 25/25.
- ✅ 6b KDS: kitchen mode in the POS (station picker, open tickets, start/ready/bump, late marker, survives a dropped connection); kitchen crew see their branch in `/v1/branches`; `test:e2e:kitchen` 13/13.
- ⬜ 6b leftovers: sound/flash on a new ticket; recall bumped tickets (`status=ALL` exists); no built-in "kitchen crew" role template (custom role today; decide with the restaurant-manager template question); push (SSE) instead of polling.
- ⬜ 6c admin set-up (stations, floor, modifiers, menus, recipes, settings, 86); ⬜ 6d restaurant report screens.
- ⬜ 6a leftovers: merge / move items between orders in the UI (API done); per-seat split helper; reprint a bill; servers without a drawer (today the Tables tab lives inside a register shift); floor positions/shapes on a drawn plan (tiles today).
⬜ Slice 7 — exit review: full service cycle (SPEC restaurant scenarios 1–10), drills (concurrent checks on one bill, two tablets on one order, void vs settlement), dev audit, design review.

⬜ Out of scope for Phase 4 (later): delivery orders, unit conversions/purchase units for recipes, sub-recipes/prep production, rule-based modifier pricing, tips, reservations, KDS push (SSE) and kitchen printers (Phase 5 devices).
⬜ Open questions for the tax adviser and the accountant: service charge base and VAT; SC/PWD share of the service charge; service charge as a liability.

## Phase 5 — Offline & integrations
Rust/Tauri shell, SQLite local store, durable local outbox, sync protocol, offline cash sales, conflict flags, ESC/POS printer & drawer adapters, real payment provider, EIS/e-invoice adapter (per compliance outcome).

## Phase 6 — Pilot readiness
Load tests, security hardening, backup/restore drill, monitoring/alerts, support workflows, UAT, compliance release review, pilot.

## Phase 7 — Differentiation (validated demand only)
Ecommerce, loyalty, forecasting, replenishment, loss-prevention analytics, multi-branch intelligence.
