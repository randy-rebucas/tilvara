# 1POS — Prioritized Backlog (dependency order)

Legend: ✅ done & verified · 🟡 partial · ⬜ not started. Update this file at the end of every session.
Open items left by finished slices and phases live in [LEFTOVER.md](LEFTOVER.md); this file keeps the plan.

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

## Phase 1 — Platform foundation
1. ✅ Identity: users, argon2id (node:crypto), login with lockout, JWT access (15 min), rotating refresh with reuse detection, logout/revoke, switch-tenant, `/me`. ✅ TOTP MFA for privileged roles and ✅ password reset (Phase 6 slice 1; mail via DevMailer until a provider is chosen), ✅ Redis-backed rate limiter (Phase 6 slice 2)
2. ✅ Tenant provisioning via `POST /v1/auth/signup` (user + tenant + 6 system roles + owner membership, atomic)
3. ✅ Roles/permissions: catalog (35 codes), role templates, scoped grants (`hasPermission`), global AuthGuard + `@RequirePermissions`, `GET /v1/members`, `GET /v1/roles`. ✅ invitations (hashed one-time token, 7-day expiry, new-user and signed-in accept, DevMailer only), ✅ role assignment, suspend/reactivate/remove, ✅ custom roles, ✅ anti-escalation (grant only what you hold at a covering scope), ✅ last-owner DB guard (deferred constraint trigger), ✅ scope-id validation trigger.
4. ✅ Legal entities (TIN, VAT status, registered name/address, RDO, price display, rounding, invoicing mode DISABLED/DEV_SERIES only). Effective-dated `tax_profiles` ✅ in Phase 2 slice 1.
5. ✅ Branches (BIR branch code), registers, terminals (one-time credential, hash not readable by app role, final revocation), archive-not-delete with child checks, scope-aware permissions, role-scope validation trigger. Terminal authentication ✅ in Phase 5 slice 1.
6. ✅ Catalog: UoM, tax categories (classification), category tree (acyclic, depth ≤ 5), products (STANDARD/SERVICE, sold by UNIT/WEIGHT), variants (SKU unique per tenant among active, case-insensitive), multiple barcodes, search + cursor pagination, archive-not-delete (frees codes).
7. ✅ Price lists (one default, branch assignment), append-only effective-dated prices (scheduled changes, no backdating), POS lookup by barcode/SKU returning the branch price in force (null when unpriced)
8. ✅ Plans (placeholder prices), one subscription per tenant (14-day Growth trial at signup), write-access rule (trial/active/past-due-in-grace = full; else read-only 402, never deletes), plan limits under advisory lock (race-tested), `GET /v1/subscription`.
9. ✅ Idempotency: `@Idempotent()` + `Idempotency-Key`, record written in the same transaction as the business change (exactly-once incl. concurrent duplicates), 422 on key reuse with different payload/user, failures leave no record. ✅ Outbox: `emitEvent()` in-transaction, `apps/workers` OutboxProcessor (claim with SKIP LOCKED + lease, retries w/ exponential backoff, DEAD after max attempts, lease-expiry reclaim, tenant context from the row), welcome-email handler, idempotency purge. ✅ dedicated `onepos_worker` DB role (Phase 6 slice 2).
10. ✅ Audit logging: every tenant mutation through `TenantService` (catalog, pricing, org, team) + login + onboarding. ✅ logout/refresh-reuse/switch-tenant/lockout/MFA/reset events (Phase 6 slice 1). Audit viewer UI planned in Phase 6 slice 6.
11. ✅ `apps/admin-web` (Next.js 16 + Tailwind 4, "Salapi" visual world chosen by the user; hand-built components instead of shadcn): ✅ BFF auth (httpOnly cookies, proxy.ts token refresh, CSRF header + origin check, allow-listed API proxy), sign-up / sign-in / accept-invite / business picker, overview, locations (entities, branches, registers, terminals with one-time key), team (invite with scope, suspend/remove), products (search, cursor paging, quick add), prices (lists, versioned/scheduled prices), subscription (limits as exact-cell meters), EN/FIL catalog, E2E smoke (`pnpm test:e2e:web`, 19 checks). ✅ review capture pass (`e2e/review.mjs`, 15 states × 1440/390) with fixes: translated validation messages (API sends zod issue code+bounds), singular select labels, legible ₱ (system-face `unicode-range` for U+20B1). Tables at 390px ✅ stacked rows below md (`RecordTable`, Phase 3 slice 5).
12. ✅ Cross-tenant adversarial suite: schema guard (`rls-catalog.test.ts`) + API/DB sweep (`isolation.test.ts`, attack matrix = live router's `:id` routes)
13. ✅ pino structured logging (`@1pos/observability`, correlation/tenant/user ids, redaction, trace ids when OTel active), ✅ OpenAPI 3.1 generation + drift test.
Exit: multiple tenants configure their businesses without cross-access (suite green). **✅ Met 2026-10-15 (session 2).**

## Phase 2 — Retail transaction engine
Slice 1 — tax foundation (session 3): ✅ ADR-0008; ✅ `tax_profiles` (append-only, effective-dated, DB no-backdating trigger, migrated from legal_entities); ✅ `discount_schemes` (SC/PWD seeded, PENDING_PROFESSIONAL_REVIEW); ✅ `@1pos/tax` pure engine (VAT incl/excl, exempt, zero-rated, non-VAT/percentage-tax sales, SC/PWD incl. partial share, no stacking, per-line centavo rounding, snapshots; golden vectors + 2,000 random-cart invariants); ✅ API: tax-profile history/create (`tax.manage`), `GET /v1/discount-schemes`, `POST /v1/tax/quote` (branch price + category + profile in force, cashier scope, `sales.discount` for ordinary discounts); ✅ DB clock is the single clock for effective dating (fixed latent host-clock drift in price stamping).
Slice 2 — sales core (session 3): ✅ ADR-0009; ✅ cashier sessions (one open per register, state machine trigger, pay-in/out, close with count, variance approval by a different user), ✅ `POST /v1/sales` (required Idempotency-Key + clientTransactionId, server recompute, stale-total refusal, cash tender with change, gapless per-register numbers, SC/PWD beneficiaries, production refusal of pending schemes, audit + outbox), ✅ append-only stock ledger with trigger-maintained balances + adjustments, ✅ isolation guards extended (5 id routes, 7 smuggling cases, 10 new tables in the sweep), ✅ DB clock 5 s skew allowance (fixed intermittent "not in force" from VM clock steps).
Slice 3 — payments + receipts (session 3): ✅ ADR-0010; ✅ `payment_intents` (state-machine trigger, request-key idempotency, consumed once) + append-only `payment_events`; ✅ provider port + deterministic `DevPaymentProvider` (refused in production by config); ✅ intent → provider call outside any transaction → settle; timeouts become UNKNOWN and are reconciled, never re-authorized (tests prove one charge); ✅ cancel/void of unused intents; ✅ split tender (intents first, cash remainder with change; electronic never gives change); ✅ `GET /v1/sales/:id/receipt` — explicitly NOT an invoice while invoicing is DISABLED, VAT/non-VAT breakdowns, SC/PWD block with ID + signature line.
Slice 4 — voids/returns (session 3): ✅ ADR-0011; ✅ append-only `sale_returns`/`sale_return_lines`, exact proration (final return takes the remainder), RESTOCK vs DAMAGED, cash refund from an open same-branch drawer (insufficient-cash and stale-refund refusals), void only in the original session and only once, per-sale advisory lock + DB within-sold trigger, own return-number series.
Slice 5 — reports (session 3): ✅ sales summary (per local day, sales/returns/net buckets), by product, by cashier, by tender (collected − refunded), tax summary by VAT rate snapshot, SC/PWD sales book (sales and negative return rows), cashier-session report (X-reading style); `reports.read` at branch scope (own session report for cashiers); local-date ranges ≤ 366 days; cross-report reconciliation tests.
Slice 6 — POS browser checkout (session 3): ✅ `apps/pos-desktop` (React + Vite, browser mode, tokens in memory only): sign-in → business → register picker (`GET /v1/pos/workstations`, works without org.read) → open shift with float → scan/SKU/name search → server-priced cart (`/v1/tax/quote`) with VAT breakdown → SC/PWD per line (name + ID) → cash with quick tenders and change / card-QR via payment intents (UNKNOWN → check payment, cancel) → `POST /v1/sales` with the same key on network retry, stale-total handling → receipt (print via browser) → shift history with manager void/return → close with count; EN/FIL; Salapi adapted for the counter (48px targets). E2E `pnpm test:e2e:pos` 15 checks. Fixes found by it: receipt flagged SC lines as VATable (now E / V/E by actual taxation), shift reopen landed on the close tab, band overflow at 390px. Offline ✅ in Phase 5.
Exit review (session 4): ✅ reconciliation suite (multi-register/multi-session day, card sale refunded in cash, local days at UTC±), ✅ failure drills (restart, connection killed mid-checkout, DB unreachable, idle connections dropped, provider timeout, duplicates), ✅ fixes: no crash on dropped DB connections, 503 `SERVICE_UNAVAILABLE` for transient DB errors, close refused over unsettled card/QR payments, `DUPLICATE_TRANSACTION` carries `saleId`, POS keeps keys on 5xx, Sell stays mounted across tabs, POS business picker fixed; ✅ POS review captures (`e2e/review.mjs`) + finish-review fixes. **Exit: ✅ met 2026-10-16.**

## Phase 3 — Inventory, purchasing, accounting
Slice 1 — costing (session 4): ✅ ADR-0012; ✅ `unit_cost`/`value` on every movement, `value`/`avg_cost` on balances, computed by the ledger trigger under the balance lock (outbound at average, emptying takes the remainder, returns at sale cost, revaluation of units sold short visible); ✅ legacy rows back-filled at reference cost; ✅ variant-ordered inserts (no deadlocks); ✅ golden vectors + concurrency + DB guards (`costing.test.ts`).
Slice 2 — purchasing (session 4): ✅ suppliers (tenant-wide, codes unique among active, archive guarded by open orders); ✅ purchase orders (state machine trigger, DRAFT-only edits, per-branch numbers); ✅ goods receipts (accepted/rejected with reason, invoice/DR refs, order lock + DB over-receipt guard, unordered and non-stock lines); ✅ supplier returns (average out, credit at receipt cost, DB within-received guard); ✅ isolation (+10 id routes, +10 smuggling cases, 7 tables).
Slice 3 — inventory ops (session 4): ✅ transfers (dispatch → in transit → receive once; shortfall reason; arrive at dispatch cost; same entity only); ✅ counts (variance computed by the trigger at posting; zero variance = no movement); ✅ waste (adjustment kind); ✅ reorder points + low-stock list net of open orders with suggested order; ✅ reports: inventory valuation (= ledger), stock movements (opening + by type = closing), by-product revenue ex VAT / COGS / gross profit; ✅ isolation (+3 id routes, +12 smuggling cases, 5 tables).
Slice 4 — double-entry ledger (session 4): ✅ ADR-0013; ✅ `@1pos/accounting` pure posting rules (13 unit tests); ✅ accounts (default chart seeded per entity + back-filled), periods, append-only journal with deferred balance trigger and closed-period trigger; ✅ every sale, return, receipt, supplier return, adjustment/waste, count, transfer, pay-in/out and drawer variance posts one entry in its own transaction; ✅ manual entries, reversals (once), period close/reopen (reason), trial balance; ✅ GL = evidence for inventory, transit, cash, card clearing, output VAT, revenue, COGS, GRNI (`ledger.test.ts`); ✅ isolation (+2 id routes, +9 smuggling cases, 4 tables).
Slice 5 — admin UI (session 5): ✅ Purchasing (suppliers, POs with lines, approve/cancel/close, receiving with accept/reject per line, receipt page); ✅ Inventory (stock & value checked against the ledger, low stock + reorder points, transfers send/receive with shortfall reason, counts with signed variance, movements report); ✅ Books (journal with two-way source links, manual entry, reversal, trial balance, chart + add account, period close/reopen); ✅ one Idempotency-Key per open form for stock/books documents; ✅ stacked rows below md; ✅ EN/FIL; ✅ E2E smoke 41/41 + review captures 35/35.
Exit review (session 5): ✅ traceability audit both ways (`traceability-audit.ts`: movement → document → entry, entry → document, per-document/branch value ties, transit clearing) — clean on a mixed day, in every drill, and over all 54 dev tenants; mutation-tested; ✅ defect fixed: multi-item stock adjustments had no document (only the first movement traced to the entry) → `stock_adjustments` (0031, back-filled) + `GET /v1/stock/adjustments[/:id]` + admin page; ✅ defect fixed: a posting could land in a month being closed (unlocked check) → period row held FOR SHARE (0032), drill fails on the old trigger; ✅ drills: connection killed mid-receipt, DB unreachable (receipt/transfer/count), double-click receive, 5 concurrent receivers of one transfer, 4 concurrent supplier returns of the last units, mixed receipts/transfers/counts/adjustments on the same items (no deadlock, books = stock), 4 concurrent reversals, close vs posting both orders; ✅ inventory officers see their own branches in `/v1/branches` (admin pickers); ✅ design finish review: 8 fixes applied; ✅ accountant review request written (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`). **Exit: ✅ met 2026-10-16**, with the accountant's answers pending before customers rely on the books.

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

Slice 3 — orders + kitchen (session 6): ✅ done.
- ✅ Orders (one live per table, state machine trigger, transfer/merge/move/cancel under order-row locks).
- ✅ Items validated against the published menu (modifiers min/max, sold-out, priced/free choices as modifier items), pending edits, frozen once fired.
- ✅ Fire by course → tickets per station.
- ✅ KDS list + statuses + bump.
- ✅ Voids after firing (`sales.void`) with an optional WASTE document (`recordPreparedWaste`).
- ✅ `orders.test.ts` (6) with concurrency drills; isolation +12 routes.

Slice 4 — bills + checks + service charge (session 6): ✅ done.
- ✅ Frozen bill (computeCart + SC/PWD per item + order discount + `serviceCharge()`), reopen before any check.
- ✅ Checks via `SalesService.createFromBill` (exact fraction shares, residual-bucket proration, "pay the rest", last check settles).
- ✅ Retail checkout refactored onto the shared `record()` path.
- ✅ `sale_charges` in sale totals; `SERVICE_CHARGE_PAYABLE` (chart + back-fill + postings); returns give charges back proportionally.
- ✅ Receipt charge line; by-product charges; recipe COGS fix in by-product.
- ✅ `bills.test.ts` (5) incl. the SPEC service cycle and concurrent checks.

Slice 5 — restaurant reports (session 6): ✅ done.
- ✅ `item-performance` (modifiers nested under their item, COGS incl. recipe, margin; Σ = by-product).
- ✅ `ingredient-usage` (expected = recipe + sold; actual adds prepared/other waste and count variance).
- ✅ `kitchen-voids` (stage reached, wasted + WASTE value, by reason and user).
- ✅ `prep-times` (per station: average/median/p90/max fired → ready, wait, pass).
- ✅ `open-orders?day=` (open or billed at the close of a day, paid by then).
- ✅ `service-charge` (per day, distributable ex VAT, cross-checked with the liability).
- ✅ Defect fixed: a check's service-charge base was always prorated, so the bases of an even split added to ₱383.94 against a ₱383.93 bill. The settling check now takes the rest of the base too.
- ✅ `restaurant-reports.test.ts` (8) incl. the ADR §10 invariants; isolation extended.

Slice 6 — UI (session 6): ✅ done.
- ✅ 6a POS table service: floor, order with modifiers/courses, send/serve/void, server-priced subtotal, bill with SC/PWD + discount, checks (rest / even / by item) priced by the new check preview, shared payment panel; receipt prints the service charge; `test:e2e:tables` 25/25.
- ✅ 6b KDS: kitchen mode in the POS (station picker, open tickets, start/ready/bump, late marker, survives a dropped connection); kitchen crew see their branch in `/v1/branches`; `test:e2e:kitchen` 13/13.
- ✅ 6c admin set-up: `/restaurant` with floor & kitchen, choices, menus (draft editor → publish), recipes, branch settings and 86; `test:e2e:web:restaurant` 22/22.
- ✅ 6d report screens: `/reports` (item performance, ingredient usage, kitchen voids, prep times, open orders, service charge) for `reports.read`; `test:e2e:web:reports` 19/19.
Slice 7 — exit review (session 7): ✅ done.
- ✅ SPEC restaurant scenarios 1–10 as one service through admin, floor and KDS (`test:e2e:service`, 22 checks).
- ✅ Drills (`restaurant-drills.test.ts`, 9): two tills on one bill (halves, thirds from a stale preview, same item, cash vs card "rest"), double-tapped check, reopen vs check, two tablets (fire/add/edit/bill races), void vs bill, void vs KDS + double void, connection killed mid-check.
- ✅ Audit: restaurant rules added to the traceability audit (mutation-checked); dev DB clean (`apps/api/test/dev-audit.ts`).
- ✅ Design finish review: 8 fixes (receipt service charge with VAT so lines add up; ingredient/sold-out names; recipe units; "To pay"; KDS "New"; menu serial; labelled phone rows; usage units).
**Exit: ✅ met 2026-10-17**, with the tax adviser's and accountant's answers on the service charge pending before customers rely on it.

## Phase 5 — Offline & integrations (plan: ADR-0015)
Slice 1 — server (session 7): ✅ done.
- ✅ Terminal authentication (`auth_terminal()` SECURITY DEFINER; `X-Terminal-Id` + `Authorization: Terminal …`; revoked → 401 `TERMINAL_REVOKED`).
- ✅ Snapshot (`GET /v1/terminal/snapshot`): priced items, tax profile, open shift; recorded with `as_of` (DB clock).
- ✅ Sync (`POST /v1/sync/sales`):
  - one transaction per envelope; dedupe on terminal + txn id + payload hash;
  - re-priced as of the snapshot, recorded through `record()` as the shift's cashier, on the device's day;
  - flags `PRICE_CHANGED` / `SNAPSHOT_EXPIRED` / `CLOCK_ADJUSTED`.
- ✅ Quarantine (`terminal_transactions`) with manager list / retry / dismiss (`cash.reconcile`); close refused while unresolved.
- ✅ `@1pos/sync-protocol`; `@TerminalAuth()` in OpenAPI; `offline-sync.test.ts` (4); isolation +3 id routes, a terminal cross-tenant case, both tables in the sweep.

Slice 2 — client engine (session 7): ✅ done.
- ✅ `@1pos/pos-offline`: `LocalStore` over `SqlDriver` (`node:sqlite` driver), `OfflineEngine` (ring up = one local tx with the device number and envelope; sync in device order, batches of 50; backoff with jitter; 401 stops; restart resumes), `httpTransport`.
- ✅ Unit tests (7); drills against the live API (`offline-engine.test.ts`, 4): outage + restart, lost answers + DB down (503) → replayed never doubled, 120 sales in batches, price rise flagged, shift closed elsewhere → quarantine, revoked till stops.

Slice 3 — receipt printing (session 7): ✅ done.
- ✅ `@1pos/escpos` (pure): a neutral `PrintableReceipt`, fixed-width layout for 32/42/48 columns (long names wrap, amounts right-aligned), CP437 with `₱` spelled `PHP`, ESC/POS bytes (init, code page, centre, bold notice, double-height total, SC/PWD signature block, partial cut, optional drawer kick); 5 unit tests with golden text.
- ✅ POS: `receiptToPrintable` / `offlineReceiptToPrintable` (receipt labels shared with the screen), `escposPrinter` / `escposDrawer` on a byte channel with a timeout; a failed print shows "The sale is recorded; print again" (SPEC: printer failure); 4 unit tests.

Slice 4 — UI (session 7–8): ✅ admin (session 7); POS offline screens (session 8, with slice 5).
- ✅ Admin `/offline-sales` (nav "Offline", needs `cash.reconcile`; BFF allows `sync/transactions` only): to review / recorded / dismissed, each problem in words (EN/FIL), record again (a refused attempt is counted and shown), dismiss with a reason, stacked rows on phones; `test:e2e:web:offline` 12/12.
- ✅ API list/get carry the cashier's name, register code and sale number.
- ✅ POS (desktop only): set-up screen, band status chip + till settings, outage banner, offline cash selling from the snapshot, offline receipt, thermal printing.
Slice 5 — Tauri shell (session 8): ✅ done (ADR-0015 "As built (slices 4–5)").
- ✅ Rust toolchain + VS Build Tools installed.
- ✅ `src-tauri`:
  - single-connection `rusqlite` store (not the SQL plugin: its pool breaks transactions);
  - TCP / Windows RAW printer;
  - Credential Manager secrets;
  - 10 granted commands, CSP, `ONEPOS_TILL_PROFILE`.
- ✅ A lost answer then offline → same transaction id → never counted twice.
- ✅ Snapshot `receiptTin`.
- ✅ `cargo test` 8; `test:e2e:desktop` 20 (real exe, simulated outage, restart, reconnect).
⬜ Slice 6 — PayMongo adapter + webhooks; invoice transmission (deferred; see LEFTOVER.md).
Slice 7 — exit review (session 8): ✅ done. **Exit: ✅ met 2026-10-17 for offline cash sales**; payment hardening (PayMongo) and invoice transmission deferred by the user's decision.
- ✅ SPEC §11 traced (ADR-0015 table).
- ✅ Till health: `GET /v1/sync/terminals` + admin "Tills" panel (silent tills); flags shown on recorded sales.
- ✅ Drills: two tills one register; close racing sync; restore from an old backup.
- ✅ Fixes: snapshot every 30 s online → 10 min; invisible flags; wrong till clock shown as "Rung up".
- ✅ Runbook `docs/operations/offline-terminal-recovery.md`.
- ✅ All nine E2E suites; integration (api 257); dev audit clean.
- ✅ Session 8: integration test for `SNAPSHOT_EXPIRED`; API URL set at runtime (set-up field, https only).

## Phase 6 — Pilot readiness (plan: ADR-0016)
Slice 1 — account security (session 9): ✅ done.
- ✅ TOTP MFA (RFC 6238, `node:crypto`): enrol with the password, confirm with a code, 10 recovery codes once, each step once, secrets AES-256-GCM under `MFA_ENCRYPTION_KEY` (required in production).
- ✅ Required for privileged members (owner, admin, accountant; any role with tenant/subscription/members/roles/terminals/tax/accounting.post/integrations) after `MFA_GRACE_DAYS` (7); older sessions re-sign in.
- ✅ Password reset (one-time 30-min link, newest only, ≤ 5/h, same answer for unknown emails, revokes sessions, MFA kept) through the `Mailer` port (DevMailer until D2).
- ✅ Auth audit events: lockout, refresh reuse, MFA, reset (platform level); logout, switch business, login {mfa} (tenant).
- ✅ Headers: API helmet in `configureApp` (CSP `default-src 'none'`, HSTS); admin CSP (no nonces) + HSTS + Permissions-Policy; `API_HOST`.
- ✅ Admin: code step at sign-in, `/forgot-password`, `/reset-password`, `/security` (QR, key, codes, turn off), grace banner and redirect. POS: code step.
- ✅ Tests: `totp.test.ts` (9), `account-security.test.ts` (19), schema guard extended, `test:e2e:web:security` (21), `test:e2e:pos:mfa` (5).
- ✅ Defect fixed: the 1440px band clipped the last tab (4px over before, worse with the new link) → `lg:gap-0`, asserted by the E2E.
Slice 2 — platform hardening (session 9): ✅ done.
- ✅ Redis rate limiter (atomic Lua counter, shared by replicas, falls back to per-instance counting when Redis is down, boot waits for the connection), rules per IP / account (hashed email) / terminal, several per route; login + per-account cap, reset + per-account cap, sync per terminal + per IP; `TRUST_PROXY_HOPS`; production requires `REDIS_URL`.
- ✅ `onepos_worker` role (0045): only role that drives the outbox and the idempotency purge (revoked from the API role); column-level reads under RLS; no table writes; `WORKER_DATABASE_URL` (required in production); dev cluster upgraded by `infra/docker/postgres/upgrade/2026-10-17-worker-role.sql`.
- ✅ `pnpm security:audit`: Next.js 16.3.5 → 16.3.8 (7 advisories incl. a critical RCE and a high SSRF); 0 left in production deps. `pnpm security:bundles` (self-test + scan) clean.
- ✅ THREAT_MODEL control → test map.
- ✅ Tests: `rate-limit.test.ts` (6), worker role (3), schema guard (worker posture), config (+3).
Slice 3 — monitoring (session 10): ✅ done (ADR-0016 "As built — slice 3").
- ✅ Prometheus registry in `@1pos/observability` (no new dependency); internal listeners `API_METRICS_PORT` 4329 / `WORKER_METRICS_PORT` 4339 on `METRICS_HOST`.
- ✅ SPEC §16 instruments by route template; business gauges via `platform_metrics()` (migrations 0046/0047); readiness checks database, migration head, Redis (degraded, not 503).
- ✅ Worker heartbeat (`worker_heartbeat()`), DEAD-letter `list|replay` CLI (audited), 25 alert rules with runbook links (`docs/operations/monitoring.md`).
- ✅ Tests: API `monitoring.test.ts`, worker monitoring + alerts tests, observability metrics, schema guard.
Pilot-safety leftovers (session 10): ✅ new MFA recovery codes (API + admin); ✅ DB guard for `PAYMENTS_OUTSTANDING` + intents only on OPEN shifts (migration 0048); ✅ Idempotency-Key required on stock adjustments; ✅ receipt SC/PWD block without the repeated discount.
Other leftovers (session 10): ✅ admin back office (purchasing, sale/shift pages, team roles/access, products, price lists, tax history, reorder points, restaurant edits, no 200-item limit); ✅ retail report screens, quick ranges, CSV for every report; ✅ Restaurant Manager / Kitchen Crew role templates (migration 0049); ✅ POS shortcuts, phone pay bar, history tags, KDS chime + Done view, seats, move/merge, split by seat, bill print; ✅ pulled from slice 6: MFA reset (owner/admin + support CLI, migration 0050), audit log reader; ✅ journal CSV export; ✅ return/void slips.
Slice 4 — backup and restore (session 11): ✅ done (ADR-0016 "As built — slice 4", runbook `docs/operations/backup-restore.md`).
- ✅ `onepos_backup` login (BYPASSRLS + `pg_read_all_data`, writes nothing); `backup_runs` + `platform_record_backup()` (migrations 0051/0052).
- ✅ `pnpm backup run|verify|keygen`: snapshot-consistent `pg_dump -Fc`, age-encrypted in stream (no plaintext on disk), manifest (SHA-256, head, row counts, catalog posture), pruning.
- ✅ `pnpm drill:restore`: file check → decrypt into `pg_restore --single-transaction` → head/counts/posture/isolation → API on the restored DB (RTO) → smoke sale → traceability audit → recorded.
- ✅ Gauges `backup_last_success_timestamp_seconds`, `restore_drill_last_success_timestamp_seconds`; alerts `OneposBackupMissing`, `OneposRestoreDrillOverdue`.
- ✅ Tests: `backup.test.ts` (8, incl. tampered file, wrong key, flipped bit, a mutated restore caught item by item), `rls-catalog.test.ts` (+2), unit `backup.test.ts` (6).
- ⏳ PITR + off-site copy (D1); scheduling on a host (slice 7).
Slice 5 — performance (session 11): ✅ done (ADR-0016 "As built — slice 5"); numbers are this machine's.
- ✅ `pnpm load:seed` (100,000 items, 20 businesses, own DB `onepos_load`) and `pnpm load:run` (registers, offline tills in their own processes, reports; stalls, slow-request timeline, CPU profile, integrity).
- ✅ Fixes:
  - drizzle relational config built once (`bindDatabase`; it was 46% of API CPU): 18 → 29 checkouts/s per instance;
  - batched pricing (`effectivePrices`) for cart, quote, checkout and menu;
  - snapshot paging (`?pageSize`, `/terminal/snapshot/:id/items`, index 0053);
  - sync time budget (`SYNC_BATCH_BUDGET_MS`) with the engine draining partial answers at once.
- ✅ 2 instances at pilot load: lookup p95 52 ms, checkout p95 397 ms, reports < 0.5 s, all tills first try, nothing lost or doubled. ⏳ checkout p99 1.6 s and sync-50 worst 5.9 s miss the targets on this laptop; re-measure on D1 staging.
⬜ Slice 6 — onboarding and support: audit log reader + screen; tenant-approved, time-limited support access; MFA reset by support; tenant data export (ZIP of CSVs, signed link); offboarding runbook; sample data for trials.
⬜ Slice 7 — deployment (needs D1, D3): Dockerfiles, container scan, CI, staging, secrets manager, migration procedure.
⬜ Slice 8 — runbooks + privacy pack (drafts for the DPO, not legal advice).
⬜ Slice 9 — UAT scripts, compliance release review, pilot runbook + daily reconciliation report (needs D4–D6).
Decisions waiting on the user: D1 hosting provider/region, D2 email provider, D4 pilot businesses, D5 invoicing during the pilot (tax adviser), D6 PayMongo keys.

## Phase 7 — Differentiation (validated demand only)
Ecommerce, loyalty, forecasting, replenishment, loss-prevention analytics, multi-branch intelligence.
