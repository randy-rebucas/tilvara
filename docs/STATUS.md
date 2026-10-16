# 1POS — Status

_Last updated: 2026-10-16 (session 5 — Phase 3 slice 5 admin UI, then the Phase 3 exit review)_

## Current phase
**Phase 3 — exit criterion met (2026-10-16, session 5): "stock and financial movements remain traceable and consistent".** Outside review still open: the accountant's answers on the default chart and posting rules (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`). Customers must not rely on the books until then; this does not block Phase 4.
**Next: Phase 4 — Restaurant** (see "Next task").
**Phase 2 — exit criterion met** (session 4, see below).

## Phase 3 exit review (session 5)
**1. Traceability audit.** `apps/api/test/integration/traceability-audit.ts` checks seven SQL invariants per tenant, in both directions:
- movement → document → entry: every movement has a document, and every document that moved value has exactly one entry;
- entry → document: every non-manual entry's document exists, in the same entity;
- per document and branch, the entry's inventory amount = that document's movement values;
- goods in transit clear on receipt.

Where it runs:
- `traceability.test.ts`: clean over a mixed day covering every document type, and mutation-tested (a forged entry is reported).
- `inventory-drills.test.ts`: at the end of every drill.
- **Over the dev database** (54 tenants, after migrating): no violations, except 39 sales, returns and cash variances that predate the ledger. All were created before the first journal entry anywhere; migration 0028 doesn't post history. Accepted and noted in ADR-0013.

**Defects found and fixed:**
- **Multi-item stock adjustments had no document.** The journal entry pointed at the first movement only, so the other items couldn't be traced to their entry. Fixed with the `stock_adjustments` document (migration 0031):
  - movements link to it, enforced by a DB check;
  - existing rows were back-filled, each document reusing the movement id its append-only entry already names;
  - new routes `GET /v1/stock/adjustments[/:id]` (isolation matrix extended), and an admin page linked from the journal.
- **A posting could land in a month being closed.** The closed-period trigger read the period without a lock. It now ensures the period row exists and holds it `FOR SHARE` (migration 0032). The trigger's refusal maps to `409 PERIOD_CLOSED`. Proved by a drill that fails on the old trigger and passes on the new one.

**2. Drills** (`inventory-drills.test.ts`, 10), each ending with the audit:
- connection killed mid-receipt → 503, nothing written, no number consumed; the same key then receives once;
- DB unreachable for a receipt, a transfer and a count → 503, nothing written;
- double-click on receive (same key ×5) → one receipt;
- five people receiving one transfer → it arrives once, the others get `ALREADY_RECEIVED`;
- four concurrent supplier returns of the last units → exactly one;
- receipts, transfers, counts, waste and adjustments on the same two items in opposite orders, all at once → no deadlock; balances = ledger, GL inventory + transit = Σ movement values;
- four concurrent reversals → one;
- close vs posting in both orders;
- inventory officers see only their own branches.

**3. Permissions.** `GET /v1/branches` now also lists a branch to users with `inventory.read`/`adjust`/`transfer` or `purchasing.manage` there (only their branches; cashiers unchanged). The built-in inventory officer role can now use the admin's branch pickers.

**4. Design finish review** of the new admin screens (impeccable-finish-reviewer, 8 material fixes, all applied):
- branch codes violet, not gold;
- phone rows label and sign every figure (PO received/rejected/remaining, movements with signed changes, low stock leads with "Suggested order");
- trial balance shows balances with Dr/Cr (catalog keys) and opening on phones;
- the journal's phone rows lead with the entry number, with the memo out of the serial line;
- the manual entry shows running debit/credit/difference and can't be posted unbalanced;
- the receive panel has its own row;
- the send-stock form names its source branch;
- ScopePicker is a `nav` with `aria-current` (not fake tabs), and SubNav fades at the edge and scrolls the active tab into view.

**5. Accountant review request** with 10 questions: GRNI vs AP, input VAT, SC/PWD presentation, revaluation to COGS, clearing account, drawer funds, deductibility of losses, percentage tax, year-end close, numbering.

## Verified in session 5 — exit review (commands actually run)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **113 passed** |
| `pnpm test:integration` | **231 passed**: database 21, api **202** (+ traceability 2, inventory drills 10), workers 8 |
| `pnpm test:e2e:web` / `node apps/admin-web/e2e/review.mjs` | **42/42** (+ adjustment entry → document) / **35/35** |
| `pnpm db:migrate` (dev) | 0031, 0032 applied; dev audit as above |
| mutation check | old period trigger restored on the test DB → close-wait drill **fails**; new trigger → passes |

Not re-run: `pnpm test:e2e:pos` (POS untouched).

## Phase 3 slice 5 — admin UI (session 5)
Three new admin areas on the real API through the BFF (allow-list extended: suppliers, purchase-orders, goods-receipts, stock, accounts, journal-entries, accounting), EN/FIL, Salapi:
- **Purchasing** (`/purchasing`): suppliers (add), purchase orders with status filter and "new order" with editable lines; order page (`/purchasing/orders/:id`): approve, cancel/close with reason, **receive goods per line (accept / reject + reason, invoice and DR refs)**, lines with ordered/received/rejected/remaining, its receipts; receipt page (`/purchasing/receipts/:id`) → its journal entry.
- **Inventory** (`/inventory`, section tabs + branch picker): stock & value (inventory-valuation report, total checked against the ledger value), low stock with "set reorder point"; transfers (send stock to a same-entity branch → transfer page with receive form: arrived per line + shortfall reason, value sent / in transit / lost); counts (post a count → variance qty/value, signed); movements report (opening + by type = closing, date range).
- **Books** (`/books`, section tabs + entity picker; callout: chart and rules await an accountant): journal with **source links both ways** (document → `/books?source=`, entry → document; account → its entries), manual entry (≥2 lines, debit/credit), entry page with reversal (reason), trial balance (from/to, balance check), chart of accounts (add), periods (close a month / reopen with reason).
- Shared: `RecordTable` (table on desktop, stacked rows below md with the key figure visible, totals row), `SubNav`, `ScopePicker`, `LineItems` (inputs named `lines.<i>.<field>` so API issue paths land on the row), `ReasonAction`/`ActionButton`. **Stock and books documents keep one Idempotency-Key per open form** (`useFormKey`), so a resubmit after no answer replays instead of posting twice. Exact decimal helpers (`sumDecimal`, `signOf`, `qty`) — no floats for money/quantities in the admin.
- Design: two new denominations documented in DESIGN.md — **₱500 gold = goods** (stock, suppliers, purchasing), **ink stripe = books**; negatives print with a true minus.
- Defects found by running it and fixed: `Serial` hard-coded `text-muted`, so coloured serials (supplier codes, and the existing "ink" SKUs on prices/locations) rendered muted → now merged with tailwind-merge; movements footer put a value under a quantity column; `peso()` printed a hyphen minus and could print "−₱0.00".
- Known gaps (in BACKLOG): the admin's branch/entity pickers need `org.read` — the built-in *inventory* role lacks it, so an inventory clerk sees "no access" on Inventory/Purchasing pickers; supplier returns, PO draft editing, supplier edit/archive and journal filters by date/type have API support but no UI yet; item names on receipts come from the first 200 products.

## Verified in session 5 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` | ok, no warnings |
| `pnpm test` | **113 passed** (api 34, tax 27, money 15, accounting 13, config 6, admin-web **6 new** (format helpers), validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **219 passed** — database 21, api 190, workers 8 (API unchanged this session) |
| `pnpm test:e2e:web` | **41/41** (+22): supplier → PO ₱912.00 → approve → receive 20+48 with 4 rejected (₱852.00, partly received) → receipt → its journal entry and back → stock value ₱852.00 = ledger → transfer 5, receive 4 with reason (₱15.00 lost; refused without reason) → count 46 vs 48 (−2, −₱23.00) → trial balance balances → close/reopen last month → manual entry + reversal → still balances; 390px: no sideways scroll on inventory/purchasing/books/trial balance |
| `node apps/admin-web/e2e/review.mjs` | **35/35** (+16 new states × 1440/390 incl. FIL) → `.impeccable/review/screens/` |
Not re-run this session: `pnpm test:e2e:pos` (POS untouched).

## Phase 3 (session 4)
- **Slice 1 — costing (ADR-0012)**: migrations 0022/0023. Every stock movement carries `unit_cost`/`value`; balances carry `value`/`avg_cost`; a `BEFORE INSERT` trigger (owned by `onepos_platform`) costs each movement under the balance row lock — outbound at the average (emptying takes the exact remainder), customer returns at the sale's cost, inbound averages; a receipt after selling short restarts the average and shows the revaluation. Inserts sorted by variant (lock order). `costing.test.ts` (6): golden vectors, rounding remainder, defaults, app cannot choose an outbound cost or bring stock in without one, 12 concurrent opposite-order multi-item sales.
- **Slice 2 — purchasing**: migrations 0024/0025, `apps/api/src/purchasing`. Suppliers; purchase orders (DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED → CLOSED / CANCELLED, trigger-enforced, draft-only edits); goods receipts (accepted vs rejected with reason, invoice/DR refs, order lock + DB over-receipt guard); supplier returns (average out, credit at receipt cost, DB guard). `purchasing.test.ts` (8).
- **Slice 3 — inventory ops**: migrations 0026/0027, `apps/api/src/inventory`. Transfers (in transit → received once, shortfall reason, arrive at dispatch cost, same legal entity only); counts (variance = counted − on hand computed by the trigger at posting; equal → no movement); waste; reorder points + low stock net of open orders; reports `inventory-valuation`, `stock-movements`, by-product revenue ex VAT / COGS / gross profit. `inventory.test.ts` (6).
- **Slice 4 — double-entry ledger (ADR-0013)**: migrations 0028–0030, new pure package `@1pos/accounting` (posting rules + default chart, 13 unit tests), `apps/api/src/accounting`. Chart per legal entity (seeded on create, back-filled), months as periods, append-only journal; every sale, return/void, goods receipt, supplier return, adjustment/waste, count, transfer dispatch/receipt, pay-in/out and drawer variance posts one balanced entry in its own transaction; manual entries, reversals (once), period close (not the month in progress) / reopen (reason), trial balance. `ledger.test.ts` (5): one entry per document, GL inventory/transit/cash/clearing/output VAT/revenue/COGS/GRNI/waste/adjustments = evidence, trial balance balances, DB refuses unbalanced entries at commit and entries in closed months.
- Isolation suite now covers 15 more id routes, ~31 more smuggling cases and 16 more tables.
- **Defects found and fixed this phase**: (1) migration 0023's legacy-cost backfill ran under FORCE RLS and updated nothing (only the throwaway test DB had run it) — fixed in place with `NO FORCE` around the backfill, same pattern as 0014; dev DB verified (balances = Σ movement values; all 29 entities got the 17-account chart). (2) The journal balance trigger referenced `NEW.journal_entry_id` in a CASE plpgsql resolves for both tables → every posting failed; fixed by 0030 (found by the full integration run).
- Dev DB migrated to 0030.

## Verified in session 4 — Phase 3 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` · `pnpm --filter @1pos/api openapi` | ok, no warnings |
| `pnpm test` | **107 passed** (api 34, tax 27, money 15, accounting 13, config 6, validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **219 passed** — database 21, api **190** (+ costing 6, purchasing 8, inventory 6, ledger 5; isolation extended), workers 8 |
| `pnpm test:e2e:pos` / `pnpm test:e2e:web` | **19/19** / **19/19** against the live API with posting enabled |
| `pnpm db:migrate` (dev) | 0022–0030 applied; backfills verified by SQL |
Slices 1 (`7ee1f3a`), 2 (`f0fd882`), 3 (`67486d7`), 4 (`5fb1071`), 5 (`b70936c`), 6 (`694d448`) done. Phase 1 done (`5878fc8`, `980eeda`). Phase 0 done (`159b94e`).

## Phase 2 exit review (session 4)
**1. Reconciliation audit** — chain sale → tenders → drawer → stock → reports → session traced through `SalesService`, `ReturnsService`, `CashService`, `ReportsService`. Untested paths found and now covered by `apps/api/test/integration/reconciliation.test.ts`:
- a multi-register, multi-session day: two shifts on R1 + one on R2, card / QR+cash / SC sales, a **card-paid sale refunded in cash** from another cashier's drawer (ADR-0011: cash refunds only), a damaged return and a void in a later session. Asserted: summary/by-tender/by-product/by-cashier/tax-summary net all equal Σ sales − Σ returns from the evidence tables; each session report holds only its own drawer movements; Σ drawers − floats = cash collected − cash refunded; recorded `expected_cash` = ledger and nothing posted after close; every intent consumed once; stock balance = Σ ledger = opening − sold + restocked.
- local business days at UTC+14 and UTC−11 (same instant → different days; ±1 day excluded). **Not tested:** one session physically spanning local midnight (needs clock control); covered by construction (session reports filter by session id, day reports by instant ranges — both tested).
- Invariants written down in `docs/architecture/DOMAIN_MODEL.md` ("Reconciliation invariants").

**2. Failure drills** — `apps/api/test/integration/failure-drills.test.ts` (8): API restart after commit (fresh instance replays the same key; new key + same transaction → `DUPLICATE_TRANSACTION` with `saleId`); **DB connection killed mid-checkout** (backend terminated while the sale waits on the session row lock → 503, nothing written, same key then sells once); **DB unreachable** (quote, payment, sale → 503, nothing written); **DB restart while idle** (dropped pool connections discarded); provider timeout (sale refused, close refused, reconcile → one charge); authorized card whose sale failed; never-received request; double-click/retry/new-key duplicates → one sale.
Defects found by the drills and fixed:
- **API process crash on a dropped DB connection** — pg emits `'error'` on a checked-out client whose server connection dies; unhandled, it exits Node. `transaction()` (`@1pos/database`) now listens while the client is checked out and destroys broken clients (`release(err)`); API and worker pools have `'error'` listeners for idle clients.
- **DB failures answered 500** → now **503 `SERVICE_UNAVAILABLE` + `Retry-After`** (`isTransientDbError`: connection errors, SQLSTATE 08/57P01-03/53300/57014/40001/40P01; unit-tested).
- **Orphan charges**: a shift could close with a card payment authorized but in no sale (or UNKNOWN) → close now `409 PAYMENTS_OUTSTANDING` (ADR-0010 §6).
- **Resubmit dead end**: `DUPLICATE_TRANSACTION` now carries `saleId`/`saleNumber`; the POS shows that sale's receipt.
POS (unknown-outcome handling): no answer **or 5xx** keeps the Idempotency-Key for sales, card/QR requests and returns (5xx used to mint a new key); a card/QR request with no answer is retried with the same key, and a different payment first re-reads the session's intents; double-click guarded; Card/QR disabled while a payment has no answer; PROCESSING gets "Check payment"; **Sell stays mounted behind other tabs** (switching to "This shift" used to drop the cart and any authorized payment); close screen lists unsettled payments with Check/Cancel. **POS business picker was broken** (expected `tokens` from `/auth/switch-tenant`, which returns `accessToken`) — fixed; found by the review pass.

**3. POS review captures + design finish review** — new `apps/pos-desktop/e2e/review.mjs` (14 states × 1440/390 → `.impeccable/review/pos/screens/`, 30 checks). Finish review (impeccable-finish-reviewer) returned 11 material fixes; done: money inputs had no box (`Field` className overwritten), Card/QR enabled during "no answer", raw status enums/failure codes and "Paid by" on declined payments (now worded + coloured tags, EN/FIL), change due at figure size, all counter targets 48px, "Remove discount" as a button and trash spaced apart, close screen order/disabled submit/danger cancel, variance shown as Expected/Counted/Short-Over, receipt deductions with "−" and TOTAL DUE → tenders → tendered → change, sale time in shift history, reason shown when Complete is disabled. Deferred to BACKLOG: sticky total/pay bar on phones, tender + voided/returned tags in shift history, SC block duplicate discount line on receipt.

**4. Docs** — ARCHITECTURE §5/§6 rewritten "as built" (ADR-0008..0011, one-transaction checkout, failure semantics), DOMAIN_MODEL state machines as built + reconciliation invariants, ADR-0010 §6, API CONVENTIONS (409 codes, 503), CLAUDE.md commands.

## Verified in session 4 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (16/16) · `pnpm exec oxlint apps packages` | ok, no warnings |
| `pnpm test` | **94 passed** (api 34 incl. 12 new transient-error cases, tax 27, money 15, config 6, validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **193 passed** — database 21, api **164** (+8 failure drills, +2 reconciliation), workers 8 |
| `pnpm test:e2e:pos` | **19/19** (+4: cart survives tab switch, double-click → one sale R1-000003, close refused over an unsettled card payment, cancel → balanced) |
| `node apps/pos-desktop/e2e/review.mjs` | **30/30** |
| `pnpm test:e2e:web` | **19/19** (shared CDP harness now prefers visible elements) |
Note: the integration run preceded the final POS-only UI edits; API/database code did not change after it.

### Phase 2 slice 1 — tax foundation (session 3)
- ADR-0008 (`docs/decisions/ADR-0008-tax-engine.md`): seller = versioned `tax_profiles`, item = `tax_categories.vat_treatment`, buyer entitlement = platform `discount_schemes`; pure engine; per-line centavo rounding; snapshots; review gate.
- DB: migrations 0014 (tables + backfill: every existing legal entity got its current VAT status/rounding as an initial profile — dev DB: 10 VAT, 2 non-VAT — then `legal_entities.vat_status/rounding_mode` dropped) and 0015 (forced RLS, append-only + no-backdating triggers, grants, SC/PWD seed).
- `@1pos/tax`: golden vectors ₱1,120 → ₱800 (VAT seller, SC) and ₱1,120 → ₱896 (non-VAT, PWD), mixed carts, exclusive prices, partial beneficiary share, refusals (stacking, unsupported VAT-keeping schemes, bad profiles), 2,000 random carts checking every peso is accounted for once.
- API: `GET/POST /v1/legal-entities/:id/tax-profiles` (create needs `tax.manage`; VAT status no longer editable via PATCH — 400), `GET /v1/discount-schemes`, `POST /v1/tax/quote` (server-authoritative price + tax for a cart at a branch; cashier allowed incl. SC/PWD; ordinary discounts need `sales.discount`; branch scope enforced; `requiresProfessionalReview` flag).
- Defect found & fixed: price and profile effective dates mixed the API host clock with the DB clock (Docker drift ≈0.2 s) → a just-set price/profile could read as "not yet effective". The DB clock is now the single clock for effective dating (`apps/api/src/common/clock.ts`).
- Guards worked as intended: the schema guard flagged the new global table (allow-listed with reason) and the router guard flagged the 2 new `:id` routes (added to the attack matrix + 2 quote smuggling cases).

### Phase 2 slice 2 — sales core (session 3)
- ADR-0009. Migrations 0016/0017: `cashier_sessions`, `cash_movements`, `cash_reconciliations`, `sequence_counters`, `sales`, `sale_beneficiaries`, `sale_lines`, `sale_tenders`, `stock_movements`, `stock_balances` — forced RLS, append-only evidence tables, session state-machine + open-session triggers, approve-once trigger, SECURITY DEFINER balance trigger (app can read, never write balances).
- API: `POST/GET /v1/cashier-sessions`, `GET /v1/cashier-sessions/:id`, `POST …/:id/movements|close|approve-variance`, `POST /v1/sales` (Idempotency-Key **required**), `GET /v1/sales`, `GET /v1/sales/:id`, `POST /v1/stock/adjustments`, `GET /v1/stock/balances|movements`.
- Tests (`sales.test.ts`, 19): full shift reconciles (lines→totals, tenders→due+change, drawer→due, stock→−qty, expected cash, zero-variance close); retry replays; 5 concurrent same-key → 1 sale; same clientTransactionId under new key → DUPLICATE_TRANSACTION; key required; 10 concurrent sales → numbers 1..10 and a failed sale consumes none; 5 failure modes leave no rows; stale total reports the new amount; beneficiary validation; one open session per register; not-owner/closed-session refusals; variance approval by another user, self-approval refused, approve once; branch scope; stock permissions, negative stock visible; append-only evidence and read-only balances.
- **Defect found & fixed:** intermittent "TAX_PROFILE_MISSING"/not-yet-priced right after setup. Root cause measured, not guessed: the Docker DB clock stepped back ≈0.9 s between transactions (later session `opened_at` < earlier profile `effective_from`). Fix: effective-date resolution allows 5 s skew (ADR-0009 §8), regression test added; 10/10 stress runs green (was ~1 in 3–8 failing).

### Phase 2 slice 3 — payments and receipts (session 3)
- ADR-0010. Migrations 0018/0019: `payment_intents` (trigger: PROCESSING → SUCCEEDED|FAILED|UNKNOWN; UNKNOWN → SUCCEEDED|FAILED; SUCCEEDED → CANCELED if unconsumed; consumed once; identity immutable), append-only `payment_events`; `sale_tenders` gains CARD/QR/EWALLET with `payment_intent_id` (unique, no change on electronic tenders).
- API: `POST /v1/payment-intents` (Idempotency-Key required, stored on the intent), `GET /v1/payment-intents?cashierSessionId=`, `GET /v1/payment-intents/:id` (with events), `POST …/:id/reconcile`, `POST …/:id/cancel`; `POST /v1/sales` accepts `{ method: 'INTENT', paymentIntentId }` tenders; `GET /v1/sales/:id/receipt`.
- `PAYMENT_PROVIDER=dev` only (production boot refuses it); `PAYMENT_TIMEOUT_MS` (default 15 s).
- Tests: 9 payment cases (split tender reconciles, card-only moves no cash, retry → same intent and 1 charge, decline, lost response → UNKNOWN → reconcile SUCCEEDED with 1 charge, never-received → FAILED, cancel, mismatch/overpayment/double tender leave no sale, owner-only + key required); receipt unit tests (never "official receipt", TIN with branch code, local time, VAT/non-VAT breakdowns, SC block) + API check; isolation +4 id routes, +3 smuggling cases, intents/events in the DB sweep.

### Phase 2 slice 4 — voids and returns (session 3)
- ADR-0011. Migrations 0020/0021: `sale_returns`, `sale_return_lines` (forced RLS, append-only, open-session trigger, within-sold trigger); `cash_movements` gains REFUND (negative, linked to the return); `stock_movements` gains RETURN (positive, linked to the return line) with direction checks.
- API: `POST /v1/sales/:id/returns` (Idempotency-Key required; VOID or RETURN), `GET /v1/sales/:id/returns`; sale view shows `returnedQuantity` per line.
- Tests (7): exact three-way proration + restock + drawer back to float; DAMAGED not restocked; SC return refunds what was paid; void once, only in its session; cashier forbidden, stale refund, insufficient drawer cash (nothing written); 4 concurrent returns of the last unit → exactly one; replayed void; append-only. Isolation: +2 id routes, +1 smuggling case, return tables in the DB sweep.

### Phase 2 slice 5 — reports (session 3)
- `GET /v1/reports/{sales-summary,by-product,by-cashier,by-tender,tax-summary,statutory-book}?branchId&from&to[&scheme]` and `GET /v1/reports/cashier-sessions/:id`. Sales count on completion, returns on processing, in the branch's local days; net = sales − returns.
- Tests (10): one realistic day (cash, SC, card, void, partial return) — every report matches hand-computed totals, cross-reconciles (Σ by-product = Σ by-tender = summary net = SQL over evidence tables; tax summary = summary buckets), SC book row with ID, session drawer = float + cash − refunds, local-date exclusion, access (cashier 403, other-branch manager 403, own session only), range validation. Defect fixed: document numbers were returned as strings (bigint) — now integers. Isolation: report endpoints in the attack/smuggle matrices and deep scan.

### Phase 2 slice 6 — POS browser checkout (session 3)
- `apps/pos-desktop` (React 19 + Vite 8 + Tailwind 4, @fontsource Archivo): full counter flow on the real API — sign-in, business, register picker, open shift, scan/search, server-priced cart, SC/PWD capture, cash/card/QR tenders, receipt, shift history with manager void/return, close with count. Browser-mode banner ("online only · no printer or drawer"); device ports per ADR-0006.
- API: `GET /v1/pos/workstations` (registers the user may run, with branch and own open shift; cashiers lack org.read so `/v1/registers` was unusable) — tested, in the isolation deep scan.
- E2E `pnpm test:e2e:pos`: **15/15** (₱78.40 cash sale with ₱21.60 change, receipt "THIS IS NOT AN OFFICIAL INVOICE" + VAT REG TIN + R1-000001; SC ₱16.50 → ₱11.78 by card with ID + signature block; ₱22.40 return refunded; drawer ₱1,056.00 balanced; no horizontal scroll at 1024/390; Filipino).
- Defects found by running it and fixed: receipt printed SC lines as "V" (now flagged by actual taxation: E, or V/E for a partial share — unit-tested); reopening a shift landed on the close tab; band overflowed at 390px.

## Verified in session 3 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **87 passed** (tax 27, api 22, money 15, config 6, validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **183 passed** — database 21, api **154** (sales+payments+returns+workstations 36, tax 18, reports 10, isolation 9, …), workers 8 |
| `pnpm test:e2e:pos` / `pnpm test:e2e:web` | **15/15** / **19/19** against live API |
| `pnpm test:e2e:web` | **19/19** against live API + `next start` |
| dev DB | migrated 0014/0015; backfill verified |

## User decisions (2026-10-15)
- **No GitHub remote yet** — keep the repo local; CI deferred. Don't create one until asked.
- **Payment provider: PayMongo** (Phase 2 payment adapter targets PayMongo; dev adapter until keys are provided).
- **Hosting: cloud** (specific provider/region still open — keep Docker images provider-neutral; OTel exporter choice waits on this).

## Verified in session 2 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` | ok, lint exit 0 |
| `pnpm test` | **55 passed** (money 15, config 6, validation 5, observability 5, workers 2, api 17 incl. OpenAPI drift check) |
| `pnpm test:integration` | **119 passed** — database **21** (14 + 7 schema guard), api **90** (77 + isolation 9 + logging 4), workers **8** |
| `pnpm test:e2e:web` | **19/19** against live API + `next start` |
| `node apps/admin-web/e2e/review.mjs` | **18/18** — 15 states × 1440/390 captured to `.impeccable/review/screens/`, no horizontal scroll at 390 anywhere |
| live boot | built API logs JSON access lines with correlation id; built worker delivered 31 queued events, each logged with origin `correlation_id` + `tenant_id` |

## Phase 1 exit review — what was checked and found
1. **Cross-tenant isolation**
   - `packages/database/test/integration/rls-catalog.test.ts` reads the system catalog: every table is tenant-keyed or allow-listed with a reason; ENABLE+FORCE RLS with only the canonical `tenant_id = app_current_tenant_id()` policy; `UNIQUE(tenant_id,id)` (reviewed leaf exceptions: audit_logs, idempotency_records, outbox_events, subscriptions — and a check that nothing references them); tenant→tenant FKs include `tenant_id`; runtime role owns nothing and has no TRUNCATE/TRIGGER/REFERENCES; SECURITY DEFINER functions owned by `onepos_platform`, pinned `search_path`, not PUBLIC-executable; `platform_set_subscription` not granted to the app. Mutation-tested with a deliberately unprotected table (3 tests fail as intended).
   - `apps/api/test/integration/isolation.test.ts`: two fully configured tenants; the attack matrix is asserted **equal to the live router's `:id` routes** (29 — a new id route without a case fails the suite) → all 404 NOT_FOUND; 16 body/query id-smuggling cases → 403/404; list/read endpoints deep-scanned for foreign ids; DB sweep driven by the catalog (fixture puts rows in every tenant table; runtime role in B's context sees/updates none of A's rows; WITH CHECK blocks foreign inserts; no context → no rows).
   - **Defect found & fixed:** `GET /v1/variants/:id/price-history` returned `200 []` for foreign/unknown variants (no data leak, but an inconsistent existence signal) → now 404.
   - Accepted by design: `audit_logs.tenant_id` NULL = platform-level event, visible to no tenant.
2. **OpenAPI**: `docs/api/openapi.json` (OpenAPI 3.1, 64 operations) generated from Nest route metadata + the same zod schemas the pipes use (`pnpm --filter @1pos/api openapi` after `pnpm build`). Documents bodies, queries, path ids, Idempotency-Key, rate limits, declared permissions and the error envelope. **Response bodies are not schema-typed yet.** Unit test fails on drift.
3. **Logging / OTel**: new `@1pos/observability` (pino JSON, redaction of credentials/tokens/cookies, AsyncLocalStorage context, `trace_id`/`span_id` mixed in when an OTel SDK is active). API: access log per request (route pattern, status, duration — never query/body/headers); tenant id added only after membership re-check. Worker: per-event scope with origin correlation + tenant id. `LOG_LEVEL` env. **No OTel SDK/exporter installed yet** (waits on hosting choice).
4. **Admin screens**: new `e2e/review.mjs` (shared CDP harness `e2e/cdp.mjs`). Findings fixed: raw zod messages ("Too small: expected string…") shown to users → API now sends issue `code`+bounds and the web translates (EN/FIL); single-choice selects labelled in plural; **₱ rendered as "P" at 13–15px** (Archivo's hairline bars) → U+20B1 now drawn from a system face via `unicode-range`. Also fixed a race in `smoke.mjs` (TIN hint text satisfied the wait before the POST). Not fixed (logged in BACKLOG): tables at 390px scroll inside their container so trailing columns/actions start off-screen; some FIL strings still English (enum labels like "VAT-registered").

## Carried forward from Phase 1 (non-blocking for Phase 2)
MFA (TOTP) for privileged roles · password reset (needs real email adapter) · Redis rate limiter (in-memory now; single instance only) · real email provider · OTel SDK + exporter · typed response schemas in OpenAPI · `onepos_worker` DB role · admin UI: product edit/variants, custom-role editor, member role editing, price-list create · Filipino copy native review · CI (needs remote). Lockout reveals account existence via 429 (accepted). Node `crypto.argon2` still experimental in Node.

## Next task (start here)
1. Commit if not yet committed (`git status`).
2. **Phase 4 — Restaurant** (SPEC Phase 4; BACKLOG): start with Inspect → Plan, then an ADR for the restaurant order model:
   - menus and versions, modifiers;
   - areas and tables; orders (dine-in and takeaway);
   - tickets, stations and KDS; courses;
   - transfer, merge and split; split bills by allocation; service charge (check PH rules in `docs/compliance/`);
   - versioned recipes with consumption and waste. Consumption should post through the Phase 3 stock ledger and books, as documents with movements and one entry each, and keep the traceability audit clean.

   Slice like Phases 2 and 3: schema + RLS + isolation → API + tests → POS/admin UI → exit review.
3. Carried, non-blocking: send the accountant review request and fold the answers into `@1pos/accounting` / ADR-0013; Phase 3 leftovers in BACKLOG.
Carried (non-blocking): supplier invoices/AP + input VAT; low-stock push alerts; blind counts; admin UI for tax profiles; SC/PWD professional sign-off (gate #6); PayMongo adapter + card/QR refunds + provider fees/settlement; Z-reading/fiscal gate G2; CSP header for POS hosting; POS phone sticky total bar; shift-history tender/void tags.
