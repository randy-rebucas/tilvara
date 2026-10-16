# 1POS — Status

_Last updated: 2026-10-16 (session 6 — Phase 4 plan (ADR-0014), slices 1–5: recipes + consumption, menu foundation, orders + kitchen, bills + checks + service charge, restaurant reports)_

## Current phase
**Phase 4 — Restaurant, in progress.** Plan: `docs/decisions/ADR-0014-restaurant-orders.md`. §2–§10 are built. The user proceeded with the ADR defaults: prices fixed at bill time, order locked once a check is paid, service charge to a liability. The tax-adviser and accountant questions remain open. Slices 1–5 done; next is slice 6, the UI (see "Next task").

## Phase 4 slice 6c — admin restaurant set-up (session 6)
- **Admin `/restaurant`** (nav item for `restaurant.manage`; BFF allow-list + kitchen-stations, dining-areas, restaurant-tables, modifier-groups, modifier-options, menus, menu-versions), five tabs, EN/FIL:
  - **Floor & kitchen** (per branch, violet): stations (add with code/default, make default, archive), areas with table tiles (add, seats, archive; empty areas archivable);
  - **Choices** (blue): groups with their rule in words, options free or priced by an item, add group (option lines), add/archive option (refused below the minimum, so hidden then);
  - **Menus** (blue): list (published version, draft, served by); menu page with the draft editor (sections and items in order, display name, kitchen station from the branches' codes, choices offered, move up/down, remove, save → publish with confirmation, refused while unsaved), the published version read-only, version history, start a new draft, archive when no branch serves it;
  - **Recipes** (gold): dishes (items not tracking stock); per dish the versions (in force / scheduled / superseded with ingredients) and a new-version form (stocked ingredients per portion, optional future start, note);
  - **Branch settings** (per branch): dine-in/takeaway menus (published only), service charge % (string-exact `rateFromPercent`/`percentFromRate`, unit-tested), dine-in/takeaway, VAT treatment with a seller-aware hint; sold-out list with "back on", marking only items this branch's menus offer.
- **E2E** `pnpm test:e2e:web:restaurant` (new) **22/22**:
  - station, area and tables;
  - the Doneness group (required, pick 1);
  - menu draft → save → publish (frozen, no draft left);
  - recipe in force (1 bun + 0.15 kg beef);
  - settings saved: server rate `0.1`, shown back as 10;
  - burger sold out with a note;
  - **the POS branch menu shows Mains → Burger with Doneness, GRILL, sold out**;
  - back on, table archived, 4 pages without sideways scroll at 390px, Filipino.
  The admin smoke still passes, **42/42**.
- **Test-only races fixed** in the new script: typing into a panel while the previous submit was still in flight, and checks matching CSS-uppercased labels.
- **Design fix after the screenshots**: table tiles carry a small labelled archive icon instead of a full red button.

## Phase 4 slice 6b — kitchen display (session 6)
- **POS kitchen mode** (`components/Kitchen.tsx`): users with `kitchen.operate` get "Open kitchen display" on the register picker (no register or drawer needed; kitchen-only users no longer see "no register access"). They pick a branch and a station, or all stations. The board polls open tickets every 4 s, oldest first, and keeps the last tickets on screen if the connection drops. Each ticket shows:
  - table or takeaway name, order and ticket number, course, and station code (all-stations view);
  - elapsed time, amber "Late" after 10 min;
  - items with choices, seat and note, each with Start → Ready, and "All ready (bump)".
  Every action is single-flight per item or ticket.
- **API**: `GET /v1/branches` also lists a branch to holders of `kitchen.operate` there (their branches only), so kitchen crew can pick it. Test added to "who sees which branch".
- **E2E** `pnpm test:e2e:kitchen` (new) **13/13**, three consecutive runs:
  - the picker offers the KDS, with Grill and Bar stations;
  - the grill ticket shows the burger with its choices and note, and never the bar's tea;
  - Start → IN_PREP on the server; bump → READY, and the bump button goes;
  - served by the floor → leaves the board;
  - all stations shows the bar ticket marked BAR;
  - no sideways scroll at 1024/390; Filipino.
  The restaurant arrangement is shared with the tables E2E (`e2e/restaurant.mjs`).
- One first-run failure was a race in the test, not the product: an item's own "Ready" button was matched before the bump landed. The test now waits for the bump.

## Phase 4 slice 6a — POS table service (session 6)
- **E2E re-run after the slice-4 checkout refactor** (open item from slice 4): fresh API on :4321 (the stale API/web from 12:05 still hold :4320/:3320 and were left alone), admin on :3321, POS preview on :3330 → `test:e2e:pos` **19/19**, `test:e2e:web` **42/42**.
- **API**: `POST /v1/restaurant/bills/:id/checks/preview` prices a check (same allocations) without recording it, so the till shows the exact amount before taking money and never prorates itself. Pricing moved into one private `priceCheck()` that `createFromBill` and the preview share. The real check still sends `expectedAmountDue`, so a check paid at another till in between is refused as `TOTAL_CHANGED`. Needs `restaurant.orders` or `sales.create` at the bill's branch. `bills.test.ts` +1 (a third = ₱157.66, preview = check, nothing recorded, stale preview refused); isolation attack matrix +1 route.
- **POS** (`apps/pos-desktop`), new **Tables** tab (shown with `restaurant.orders`; kept mounted like Sell so a check's card payment survives a tab switch):
  - floor: areas, table notes (violet; free / open / billed, to send, ready), takeaway orders, open a table with guests or a takeaway with a name; polls every 8 s;
  - order: published menu by section, modifier composer (required/max choices, quantity, course, kitchen note), ticket with status tags, send all / by course, served, void after firing (manager, reason, written off or not), remove pending, move table, cancel; server-priced subtotal via `/v1/tax/quote`; polls every 5 s;
  - bill: SC/PWD diners per item and an order discount before printing; lines with paid shares, service charge line, reopen (no checks yet); checks by "everything left", "split evenly" (exact shares of what is left) or by item, each previewed by the server.
  - Payment is now one `usePayment` hook + `PaymentPanel` shared by the counter and checks: intents, unknown outcomes, kept keys, duplicate → recorded sale. Counter E2E unchanged after the move (19/19).
- **Defect found and fixed**: the POS receipt never rendered `charges`, so a check's slip omitted the service charge line (ADR-0014 §9). It now prints on its own line.
- **E2E** `pnpm test:e2e:tables` (new, `apps/pos-desktop/e2e/tables.mjs`) **25/25**: required choice blocks adding, burger ×2 with Medium + Cheese, subtotal ₱340 → ₱430, send to kitchen, extra tea voided, bill ₱473.00 with the charge line, split evenly ₱236.50 cash (change ₱13.50, receipt with charge) + ₱236.50 card → settled, T1 free, takeaway bill ₱45.00 without a charge, drawer ₱1,236.50, no sideways scroll at 1024/390, Filipino.
- DESIGN.md: restaurant records map to existing denominations (places violet, menu blue, recipes gold, orders/bills/tickets unstriped with worded states).

## Phase 4 slice 5 — restaurant reports (session 6)
- **API**: six read-only reports in `apps/api/src/reports/restaurant-reports.service.ts`. Each needs `reports.read` at the branch, is not plan-gated, and uses the same local-day conventions as the retail reports. Details are in ADR-0014 §10.
  - `GET /v1/reports/item-performance`: items with their priced modifiers nested under them; quantity, net sales, revenue ex VAT, COGS (incl. recipe), margin, and "with modifiers" totals.
  - `GET /v1/reports/ingredient-usage`: per recipe ingredient, expected (recipe + sold as itself) vs actual (+ prepared waste + other waste − count variance), in quantity and value.
  - `GET /v1/reports/kitchen-voids`: voids after firing with the stage reached, wasted or not, and WASTE value; by reason and by user.
  - `GET /v1/reports/prep-times`: per station and overall: fired → ready (avg/median/p90/max), wait to prep, ready → served.
  - `GET /v1/reports/open-orders?branchId&day`: open or billed at the close of the day (or now), with what had been paid by then.
  - `GET /v1/reports/service-charge`: per day charged − returned, the distributable amount (ex VAT) and a ledger cross-check against `SERVICE_CHARGE_PAYABLE`.
- **Defect found and fixed (slice 4)**: a check's service-charge `base` was always prorated, never the remainder. An even split of a ₱383.93 base recorded 191.97 + 191.97 = ₱383.94. The settling check now takes the rest, and `bills.test.ts` now asserts Σ bases = the bill's base. Amounts were never affected.
- **Test fixed (flaky, pre-existing)**: `costing.test.ts` ordered the three sale movements by `created_at`, which the Docker clock can step backwards (see session 3). It now orders by sale number.
- **Tests**: `restaurant-reports.test.ts` (8). One service day covers: a split table with a return, a wasted void while cooking, a void before cooking, a half-paid takeaway, a cancelled order, spoiled beef and a short count. Every report is checked against hand-computed figures and the evidence rows:
  - item performance = by-product = sale lines − return lines;
  - usage = movements by type;
  - void waste = its journal entry;
  - distributable = the liability credit.
  It also asserts the ADR §10 invariants (consumption = sold × recipe in force; every fired item accounted for exactly once), checks access and validation, and ends with a clean traceability audit.
- **Isolation**: the six reports are in the smuggle matrix and the deep scan. No new `:id` routes.
- **Docs**: ADR-0014 §10 "as built", DOMAIN_MODEL "Phase 4 invariants", OpenAPI regenerated.

## Phase 4 slice 4 — bills, split checks, service charge (session 6)
- **Schema**: migrations 0039/0040, all with forced RLS.
  - New tables: `order_bills`, `order_bill_lines`, `order_bill_beneficiaries`, `order_bill_charges`, `order_bill_allocations`, `sale_charges`, `sale_return_charges`.
  - New columns: `sales.order_bill_id` and `sale_lines.parent_line_id` (same-sale FK).
  - Bill evidence is append-only. The bill state trigger allows ACTIVE → SETTLED/VOIDED, and voiding is refused once a check is paid.
  - Allocation guard: each line's shares are summed as exact fractions under the bill row lock, never more than 1.
  - The new system account `SERVICE_CHARGE_PAYABLE` (2200) is in `DEFAULT_CHART` and back-filled for every entity (dev: applied).
- **Tax engine**: `serviceCharge()` charges base = items net of every discount, ex VAT, then taxes the charge as its own line (VAT seller: VAT on top; non-VAT: percentage-tax sales). Unit-tested, including the SC/PWD discounted base, the non-VAT seller and rounding.
- **Accounting**: `salePosting` / `saleReturnPosting` credit or debit `SERVICE_CHARGE_PAYABLE` with the charge ex VAT; its VAT stays in output VAT (unit test).
- **Bill** (`POST /v1/restaurant/orders/:id/bill`):
  - priced by `TaxService.computeCart` over live items, with priced modifiers as child lines;
  - SC/PWD per item, itemized or shared;
  - order `discountRate` (sales.discount) spread over non-statutory lines;
  - service charge from branch settings;
  - `requiresProfessionalReview` when SC/PWD meets the service charge;
  - order → BILLED (no adds or voids); reopen via `/void` only before any check.
- **Checks** (`POST /v1/restaurant/bills/:id/checks` → `SalesService.createFromBill`):
  - allocations by whole quantity or n/d share; omitted means "pay the rest"; modifiers follow their item;
  - proration rounds the amount due first and gives one sales bucket the residual, so even splits look right; the final share takes the exact remainder;
  - the charge follows the check's share of the items' amount due;
  - the last check settles the bill and the order.
  - `SalesService.create` was refactored so retail and checks share one `record()` path (tenders, numbering, lines with parents, charges, allocations, stock + consumption, books, audit, outbox). The 74 existing checkout/returns/drill/ledger/report tests passed on the new path before the new tests were written.
- **Returns**: the charge goes back in proportion to the items returned; the return that empties the sale takes the rest; the liability is reversed.
- **Receipts and reports**: the receipt prints "Service charge 10%" on its own line. By-product lists `charges` apart, so Σ products + Σ charges = summary.
- **Defect found and fixed (slice 1 gap)**: by-product COGS ignored CONSUMPTION, so dishes showed full gross profit. Consumption is now attributed to the sold line's item.
- **Tests**: `bills.test.ts` (5):
  - the full SPEC service cycle: modifiers, kitchen, bill ₱473.00 = items ₱430 + charge 38.39 + 4.61 VAT, even split 236.50 + 236.50, settled, table freed, Σ checks = bill per bucket, stock once per dish, GL (Sales 383.93, charge payable 38.39, output VAT 50.68, COGS 136), audit clean, receipt, reports reconcile, shift closes balanced;
  - splits by item/quantity, over-payment refused, 3 concurrent "pay the rest" → one;
  - SC itemized (₱107.14, charge on the discounted base) + discount on non-statutory lines + reopen rules + beneficiary on the check;
  - returns of a charged check (charge 9.00 with the tea, then the rest; liability nets to 0);
  - DB guards (fraction guard refuses 1/3 + 3/4, append-only, no reopen after a check).
- **Isolation**: +4 id routes, +2 smuggling cases, 3 list scans, all 7 tables in the sweep (the fixture bills with an SC diner, pays, returns part).

## Phase 4 slice 3 — orders and kitchen (session 6)
- **Schema**: migrations 0037/0038 add `restaurant_orders`, `kitchen_tickets` and `order_items`, all with forced RLS. Composite FKs pin an order's table and a ticket's order and station to the same branch.
- **DB guarantees** (triggers and column grants):
  - order transitions OPEN → BILLED → SETTLED, BILLED → OPEN, OPEN → CANCELLED/MERGED; closed orders never change;
  - one live order per table (partial unique index);
  - items are inserted as PENDING into open orders only, beside a parent of the same order;
  - fired items are frozen (quantity/course; variant, kind and name are never updatable);
  - status only moves forward or to VOIDED (final);
  - only pending items can be deleted, and items move only into open orders;
  - orders and tickets are never deleted.
- **API** (`orders.*`, `kitchen.service.ts`):
  - open (dine-in on a free table / takeaway), list (live/all, with item counts), get (items with modifiers, tickets);
  - add items (required Idempotency-Key) validated against the branch's published menu: on menu, available (priced, not 86), modifiers within each group's min/max, whole units;
  - edit/remove pending items (modifiers follow);
  - void fired items (`sales.void`, required key); a *wasted* void writes one WASTE stock adjustment (tracked item itself or its recipe, plus tracked priced modifiers) with its journal entry;
  - fire by course → one ticket per station and course (station code, else default; refused with no station); re-fire is a no-op;
  - transfer table, merge, move items (to an open order or a new order on a free table), cancel (only when nothing live was cooked);
  - KDS ticket list (open/all, per station, shows where the food goes now), item status (IN_PREP/READY kitchen; SERVED kitchen or floor) and bump;
  - archiving a table is refused while it has a live order.
- **Tests**: `orders.test.ts` (6):
  - order taking: table occupied, menu rules, sold-out, key required, replay not doubled, pending edits with modifiers following, access;
  - kitchen: course firing into station tickets, no-op re-fire, frozen fired items, KDS view, permissions per status, no going backwards, bump, served by floor, branch without a station;
  - voids: cashier refused, wasted void → WASTE document (₱136 = 2 buns + 0.3 kg beef + 2 cheese slices) with entry and clean audit, non-wasted void has no stock effect, cancel after all voided;
  - moving: transfer, merge, move to a new table (KDS follows), whole-item moves only, cancel rules, table archive refused;
  - drills: 5 concurrent opens of one table → 1, 10 concurrent adds from two tablets → all once, 5 concurrent fires → each item once, opposite-direction merges → one wins, no deadlock;
  - DB guards.
- **Isolation**: +12 id routes, +10 smuggling cases, 3 more list scans, all 3 tables in the DB sweep.
- **Defect found by the isolation suite and fixed**: move-items to a new table created the order before validating the items, so a bad item id answered `TABLE_OCCUPIED` instead of 404 (and could have opened a table for nothing). Items are now validated first.

## Phase 4 slice 2 — menu foundation (session 6)
- **Schema**: migrations 0035/0036 add 12 tables, all with forced RLS:
  - floor: `kitchen_stations`, `dining_areas`, `restaurant_tables`;
  - modifiers: `modifier_groups`, `modifier_options`;
  - menus: `menus`, `menu_versions`, `menu_sections`, `menu_items`, `menu_item_modifier_groups`;
  - per branch: `restaurant_settings`, `sold_out_items`.
- **DB guarantees**:
  - set-up rows are archived, never deleted;
  - station codes are unique per branch, with one default station;
  - a table's area is pinned to the same branch by composite FK, and an item's section to the same version;
  - one draft and one published version per menu;
  - versions only go DRAFT → PUBLISHED → RETIRED and are inserted as drafts;
  - published and retired content is frozen (trigger);
  - min/max choice bounds.
- **API** (`apps/api/src/restaurant/floor.*`, `menus.*`):
  - stations, areas and tables (CRUD + archive);
  - modifier groups and options (archive refused if it leaves too few options);
  - menus: create (draft v1), rename, archive (refused while a branch serves it), new draft copied from published, replace draft content, publish (locks the menu; retires the previous version);
  - per-branch settings (menus per order type, service charge rate / order types / VAT treatment);
  - 86 list/set;
  - `GET /v1/branches/:id/menu`: the published menu with branch prices, option prices, sold-out and availability.
- **Access**:
  - set-up needs `restaurant.manage` at the branch (tenant-wide for menus/modifiers) plus the `restaurant` plan feature;
  - floor staff and kitchen read their branch's set-up;
  - 86 needs `kitchen.operate` or `restaurant.manage`;
  - the POS menu needs `restaurant.orders`.
  - Finding: the built-in branch manager has no `restaurant.manage`, so only owner/admin can set up a restaurant (BACKLOG: decide on a restaurant-manager template).
- **Tests**: `menu.test.ts` (7):
  - floor rules, including a cross-branch area move refused by API and FK;
  - access, including the plan gate;
  - modifier bounds;
  - version lifecycle with DB-level freeze, no going back, and insert-as-published refused;
  - 5 concurrent publishes → one;
  - archived references block publishing;
  - branch menu with prices, sold-out and unpriced items, menu in use.
- **Isolation**: +22 id routes, +12 smuggling cases, 9 more list scans, all 12 tables in the DB sweep, and A's set-up checked untouched.
**Phase 3 — exit criterion met** (session 5). Outside review still open: the accountant's answers (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`). Customers must not rely on the books until then.
**Phase 2 — exit criterion met** (session 4, see below).

## Phase 4 slice 1 — recipes and consumption (session 6)
- **Plan** (ADR-0014) has seven slices. Key decisions:
  - menu items are catalog variants (one price and tax path);
  - an order is operational only and becomes sales through a frozen **bill**;
  - **split checks are exact prorations** of the bill (as returns are);
  - service charge is a separate charge line posted to a liability (`SERVICE_CHARGE_PAYABLE`, RA 11360); the defaults are flagged for the tax adviser and the accountant;
  - a void after cooking becomes a WASTE document.
- **Schema**:
  - Migrations 0033/0034: `recipe_versions` (numbered, effective-dated, append-only, never backdated) and `recipe_ingredients` (append-only).
  - Triggers: the sold item must not track stock, and the ingredient must.
  - New movement type `CONSUMPTION` (outbound, linked to sale + sale line + recipe version; type/direction/link checks updated). The costing trigger needed no change.
- **Checkout**: `SalesService.create` adds one CONSUMPTION per line and ingredient for untracked lines with a recipe in force (DB clock). These are sorted by variant with the sale's movements, and their value is in the sale's COGS, so the sale still has one entry.
- **Returns**: RESTOCK of a recipe-made line → `422 NOT_RESTOCKABLE`. A void records such lines as DAMAGED. Ingredients stay consumed.
- **API**: `GET/POST /v1/variants/:id/recipe` (history with IN_FORCE/SCHEDULED/SUPERSEDED; create needs `restaurant.manage` and the `restaurant` plan feature). Consumption is not feature-gated.
- The traceability audit maps CONSUMPTION → its SALE. Admin movement label added ("Used in recipes" / "Nagamit sa recipe").
- **Tests**: `recipes.test.ts` (5):
  - golden burger costs (bun/beef/cheese at average), sale entry COGS = ingredients + shelf item, movements report;
  - versions (scheduled waits, new version applies, empty stops consumption, backdating refused in API and DB, append-only);
  - rules and access, including a starter-plan downgrade where consumption continues;
  - DAMAGED-only returns and the void restocking only shelf items;
  - 10 concurrent dish + shelf sales sharing an ingredient in opposite orders (no deadlock, ledger = balances);
  - the audit is clean in every case.
- **Isolation**: +2 id routes, +1 smuggling case, both new tables in the DB sweep (the fixture sells a dish).

## Verified in session 6 (commands actually run)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` (exit 0) · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **113 passed** (unchanged) |
| `pnpm test:integration` | **236 passed**: database 21, api **207** (+5 recipes; isolation extended), workers 8 |
| `pnpm db:migrate` (dev) | 0033, 0034 applied |
| slice 2: `pnpm build` · `pnpm typecheck` · oxlint (exit 0) · openapi · `pnpm test` | ok |
| slice 2: `pnpm test:integration` | **243 passed**: database 21, api **214** (+7 menu; isolation extended), workers 8 |
| slice 2: `pnpm db:migrate` (dev) | 0035, 0036 applied |
| slice 3: `pnpm build` · `pnpm typecheck` · oxlint (exit 0) · openapi · `pnpm test` | ok |
| slice 3: `pnpm test:integration` | **249 passed**: database 21, api **220** (+6 orders; isolation extended), workers 8 |
| slice 3: `pnpm db:migrate` (dev) | 0037, 0038 applied |
| slice 4: `pnpm build` · `pnpm typecheck` · oxlint (exit 0) · openapi · `pnpm test` (tax **30**, accounting **14**, api 34, …) | ok |
| slice 4: `pnpm test:integration` | **254 passed**: database 21, api **225** (+5 bills; isolation extended), workers 8 |
| slice 4: `pnpm db:migrate` (dev) | 0039, 0040 applied (service charge account back-filled) |
| slice 5: `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` (exit 0) · openapi · `pnpm test` (api 34, tax 30, accounting 14, …) | ok |
| slice 5: `pnpm test:integration` | **262 passed**: database 21, api **233** (+8 restaurant reports; isolation extended), workers 8. The first run had 1 failure in `costing.test.ts` (clock-order flake, passed alone; fixed as above); the rerun was all green |
| slice 6a: `test:e2e:pos` / `test:e2e:web` against a freshly built API (:4321) | **19/19** / **42/42** (re-run owed since slice 4: done) |
| slice 6a: `pnpm exec vitest … bills.test.ts isolation.test.ts` · `pnpm test` · typecheck · oxlint · openapi | bills **6**, isolation 9, unit all green |
| slice 6a: `pnpm test:e2e:tables` | **25/25** |
| slice 6b: isolation + inventory-drills (19) · `test:e2e:kitchen` ×3 · `test:e2e:tables` · `test:e2e:pos` | all green: 13/13, 25/25, 19/19 |
| slice 6c: admin typecheck · oxlint · admin unit (8) · `test:e2e:web:restaurant` · `test:e2e:web` (fresh build on :3321) | 22/22 · 42/42 |
No migrations in slices 5–6c. An API process from before this slice (PID 18856, started 12:05, not started by this session) was holding port 4320, so a fresh API could not start; it was left running. Re-run both E2E suites against a rebuilt API before the exit review, because checkout was refactored.
Not re-run: `pnpm test:e2e:web` / `test:e2e:pos` (admin change is one label and one filter option; POS untouched).

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
2. User review of ADR-0014's proposed parts. The choices that are theirs to confirm:
   - prices are fixed when the bill is printed;
   - an order is locked once a check is paid;
   - service charge goes to a liability, and its base/VAT defaults (these also go to the tax adviser).
3. ~~Re-run the POS/web E2E after the checkout refactor~~ — done (19/19, 42/42).
4. **Phase 4 slice 6 — UI**: 6a POS table service ✅, 6b KDS ✅, 6c admin set-up ✅. Next 6d: admin report screens for the six restaurant reports (slice 5 API).
5. Then slice 7 (exit review: service-cycle drills, dev audit, design review).
6. Open decision for the user: restaurant set-up for branch managers (a "restaurant manager" template or grant `restaurant.manage` to `branch_manager`).
7. Carried, non-blocking: send the accountant review request and fold the answers into `@1pos/accounting` / ADR-0013; Phase 3 leftovers in BACKLOG.
Carried (non-blocking): supplier invoices/AP + input VAT; low-stock push alerts; blind counts; admin UI for tax profiles; SC/PWD professional sign-off (gate #6); PayMongo adapter + card/QR refunds + provider fees/settlement; Z-reading/fiscal gate G2; CSP header for POS hosting; POS phone sticky total bar; shift-history tender/void tags.
