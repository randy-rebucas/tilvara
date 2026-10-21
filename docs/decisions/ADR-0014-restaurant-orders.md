# ADR-0014: Restaurant orders, kitchen, bills and recipe consumption

- Status: Accepted for §2–§9 (built in slices 1–4, 2026-10-16); §10 reports partly built (charges in by-product, recipe COGS), the rest is slice 5. The user proceeded without changing the defaults (prices fixed at bill time, order locked once a check is paid, service charge to a liability); the tax-adviser and accountant items below remain open. Items marked **(tax adviser)** or **(accountant)** are defaults pending professional review; they are configuration or posting rules, not hard-coded law.

## Context
SPEC §6.4 / Phase 4: menus and versions, modifiers (required/optional, priced), areas and tables, dine-in and takeaway orders, table transfer, merge and split, kitchen tickets routed to stations, KDS with preparation statuses, courses, item voids, split bills and split payments, service charge and discounts, versioned recipes with ingredient consumption and waste, restaurant reports. Exit: *a restaurant completes a full service cycle and reconciles its stock, payments and financial records.*

Hard rules carried in: "an open table or kitchen ticket is not a finalized sale"; "cancelling a kitchen item never rewrites a settled transaction"; checkout only via `SalesService.create` with server recompute (ADR-0009); stock only through `stock_movements` costed by the trigger (ADR-0012); one journal entry per document (ADR-0013); the traceability audit stays clean.

What exists: `restaurant.manage`, `restaurant.orders`, `kitchen.operate` permissions (branch manager and cashier templates already hold some) and a `restaurant` plan feature. No composite, modifier or recipe concept; one UoM per product, no conversions; stock per branch.

## Decision

### 1. Menu items are catalog items
A dish, a drink and a priced add-on are **product variants** (usually `track_inventory = false`). Price, tax category and VAT treatment come from the existing price lists and tax path, so there is still one place a price lives and one tax engine. Menus decide *what is offered where and how it is routed*, never the price.

### 2. Menus and versions
- `menus` (tenant), assigned per branch and order type in `restaurant_settings` (`dine_in_menu_id`, `takeaway_menu_id`).
- `menu_versions`: `DRAFT → PUBLISHED → RETIRED`; a published version is immutable (trigger) and exactly one is published per menu. Editing = copy to a new draft, publish (retires the old one atomically).
- `menu_sections` and `menu_items` belong to a version: variant, section, sort, optional display name, a **station code** for routing, and attached modifier groups (`menu_item_modifier_groups`).
  - Routing by code (e.g. `GRILL`) keeps one tenant-wide menu usable at every branch. Each branch's `kitchen_stations` carry codes, and items with no matching code go to the branch's default station.
  - A draft's content is replaced whole (`PUT /v1/menu-versions/:id/content`). A trigger freezes the content of published and retired versions, and another allows only DRAFT → PUBLISHED → RETIRED.
  - Publishing locks the menu row and retires the previous version (partial unique indexes: one draft, one published). A new draft copies the published content.
- **86 / sold out**: `sold_out_items` per branch and item. A row exists while sold out and is deleted when the item is back; changes are audited. It sits outside the version, so it changes mid-service without republishing. `kitchen.operate` or `restaurant.manage` may set it.
- **What a branch serves** (`GET /v1/branches/:id/menu?orderType=`, `restaurant.orders`): the assigned menu's published version with each item's **branch price** (null = not priced there, not available), sold-out flags, and modifier groups with option prices (free options are `0`).
- Order items record the `menu_version_id` they were ordered from.

### 3. Modifiers
- `modifier_groups` (tenant): name, `min_select`, `max_select` (required = `min ≥ 1`), and options.
- `modifier_options`: name, and **optionally a variant**. A priced option ("Extra cheese") points to a variant whose price-list price is the charge and whose recipe or stock is consumed like any item. A free option ("No onions", "Medium rare") has no variant: it is an instruction printed on the kitchen ticket with no money or stock effect.
- Selections are validated server-side when the item is added (min/max, option belongs to an attached group, option and variant active).
- On the sale, a priced option becomes a **child sale line** (`sale_lines.parent_line_id`, new nullable column). It inherits the parent's SC/PWD assignment and is returned together with its parent.
- Rule-based modifier pricing (e.g. "first two free") is out of scope.

### 4. Recipes and consumption (applies to every sale, retail or restaurant)
- `recipe_versions` per sold variant: numbered 1, 2, 3, …, append-only and effective-dated (DB clock, no backdating — same rules as prices and tax profiles). No separate header table: the variant is the recipe's identity. An empty version stops consumption from its date.
- `recipe_ingredients`: ingredient variant and quantity per one unit sold, in the ingredient's own UoM (4 dp). Triggers enforce that the ingredient tracks stock and that the sold item does not, since otherwise one sale would move stock twice. Unit conversions and sub-recipes (prep batches) are out of scope and stay in BACKLOG; recipes are entered in stock units.
- API: `GET /v1/variants/:id/recipe` (history with IN_FORCE / SCHEDULED / SUPERSEDED; `catalog.read`), `POST /v1/variants/:id/recipe` (new version; `restaurant.manage` + `restaurant` plan feature). Consumption itself is not feature-gated, so the books stay right after a downgrade.
- **Consumption happens at sale time inside `SalesService.create`** for any untracked line whose variant has a recipe version in force (DB clock). Each ingredient gets a new movement type **`CONSUMPTION`** (outbound) linked to `sale_id`, `sale_line_id` and `recipe_version_id`. There is one row per line and ingredient, so each traces to its line. Quantity = sold × recipe quantity, rounded to 4 dp, and a trace amount that rounds to 0 moves nothing. Rows are inserted with the sale's other movements, sorted by variant (lock order).
- Costed by the trigger at the average like any outbound movement. The ingredient value is added to the sale's COGS, so the sale still posts **one** entry whose INVENTORY credit = Σ of its movement values.
- A separate type rather than reusing `SALE`, because the trigger costs a `RETURN` at "the first `SALE` movement of the sale line". With several ingredients per line that lookup would pick the wrong item.
- **Returns and voids of recipe-made lines cannot RESTOCK** (`422 NOT_RESTOCKABLE`): cooked food does not go back on the shelf. The refund still happens; COGS stays.
- Theoretical usage = Σ `CONSUMPTION`. Actual usage = what counts and waste show. The movements report already splits by type.

### 5. Areas, tables, stations
- `dining_areas` (branch), `restaurant_tables` (area, code unique per branch among active, seats, optional layout x/y/shape for the floor plan). `kitchen_stations` (branch, name; e.g. Grill, Bar, Pastry).
- Archive, never delete. Table status is **derived** from open orders, never stored.

### 6. Orders (operational, never financial)
- `restaurant_orders`: branch, per-branch number, type `DINE_IN | TAKEAWAY` (delivery later), table (dine-in), guest count, status `OPEN → BILLED → SETTLED`, plus `CANCELLED` and `MERGED` (with `merged_into_id`). At most one non-final order per table (partial unique index).
- `order_items`: an `ITEM` (variant from the published menu) or a `MODIFIER` of one. A priced option carries its variant; a free instruction has none. Rows hold the name as ordered, quantity (modifiers follow their item), course (1–9), optional seat and note, station code and `menu_version_id`. Prep status: `PENDING` (not yet fired) → `FIRED` → `IN_PREP` → `READY` → `SERVED` (forward only, skipping allowed), or `VOIDED` (final).
  - Triggers and column grants enforce the rest:
    - items are inserted as PENDING into OPEN orders only, next to their parent;
    - once fired, quantity and course are frozen, and variant, kind, name and parent are never updatable;
    - only PENDING items can be deleted;
    - items move only into OPEN orders.
  - Adding validates against the branch's published menu for the order type: the item must be on it and available (priced here, not sold out). Modifier choices must belong to the item's groups, within min/max and available. Whole units are required unless the unit allows fractions.
- **Voids after firing** need `sales.void` and a reason. A void marked *wasted* writes one `WASTE` stock adjustment in the same transaction: the item itself if tracked, else its recipe in force, plus tracked priced modifiers (`recordPreparedWaste`). It is costed, posted to Spoilage and waste, linked from the item (`waste_adjustment_id`) and traceable through the existing document. Pending items are removed, not voided.
- Mutations lock the order row (`FOR UPDATE`); two orders are locked in id order. Adding items and voids require an Idempotency-Key.
- **Transfer** a table: move the order to a free table. **Merge**: move every item of B into A, and B becomes `MERGED`. **Move items**: selected items (with their modifier children) go to another open order or to a new order on a free table; voided items stay put. **Cancel**: only when nothing live was cooked; pending items disappear. All are recorded in the audit log. A table with a live order cannot be archived.

### 7. Kitchen tickets and KDS
- **Fire** sends the order's `PENDING` items of the chosen courses (default: all). It groups them by station into `kitchen_tickets` (per-branch number, station, course, fired_at, fired_by): one per station and course. An item routes to the branch's station with its station code, else the default station, else the fire is refused (`NO_KITCHEN_STATION`). Re-firing with nothing pending is a no-op, so it is safe to retry.
- **KDS**: `GET /v1/kitchen/tickets?branchId&stationId&status=OPEN|ALL` (polling, ~3 s; push via SSE is a later option). A ticket shows where its food goes now (current order and table, even after a move). Item status changes: `IN_PREP`/`READY` need `kitchen.operate`; `SERVED` needs `kitchen.operate` or `restaurant.orders`. "Bump" moves a whole ticket's fired and in-prep items to READY. Timestamps (fired, prep started, ready, served) are kept for reports.
- Courses: items carry a course number. Later courses can be held and fired on demand.

### 8. Bills: freeze, then settle in one or more checks
- **Bill** (`POST /v1/restaurant/orders/:id/bill`, `restaurant.orders` + `sales.create`, required Idempotency-Key). Every item must be fired or removed first. The server runs `TaxService.computeCart` over the order's live items, as priced lines with priced modifiers as child lines. It applies:
  - SC/PWD per item (itemized, or a headcount `share`; the item's modifiers follow);
  - an order-level `discountRate` (`sales.discount`), spread line by line on the price basis and skipping statutory lines, which refuse stacking (two passes through `computeCart`);
  - the service charge (§9).
- The result is stored as an immutable snapshot: `order_bills`, `order_bill_lines`, `order_bill_beneficiaries` and `order_bill_charges`. Header buckets include the charges. The order becomes `BILLED`, and adding items and voids are then refused. The bill can be **reopened** (`POST /v1/restaurant/bills/:id/void`, back to `OPEN`) only while no check is paid; a trigger enforces that too. This fixes prices and tax for the whole table even if a price changes mid-service, and is what the guest sees on the printed bill.
- **Checks** pay the bill: `POST /v1/restaurant/bills/:id/checks` (`SalesService.createFromBill`, required Idempotency-Key) with `{ cashierSessionId, clientTransactionId, allocations?: [{ billLineId, quantity | share: {num, den} }], tenders, expectedAmountDue? }`. Omitting `allocations` pays everything still unpaid. Allocations name top-level lines only; modifiers follow their item's share.
  - **Proration**: a sale line is the bill line × the share. The amount due is rounded first, and the line's first non-zero sales bucket takes the residual, so half of ₱40.00 is ₱20.00, not ₱20.01. The allocation that completes a bill line takes the exact remainder of every bucket and of the quantity. Σ of the checks therefore equals the bill, centavo for centavo.
  - **Exactly once**: shares are exact fractions (`share_num/share_den`). The bill row lock serialises checks, and a DB guard sums each line's shares as exact fractions (under the same lock) and refuses anything beyond the whole.
  - Each check is an ordinary **Sale**: its own number, tenders (split payment), receipt, cash movement, consumption, journal entry, and returns. Everything else in ADR-0009 (Idempotency-Key, duplicate `clientTransactionId`, stale-total refusal, one transaction) is unchanged.
  - "Split evenly by N" is N checks of share 1/N on every line.
  - The check that pays the last share settles the bill and the order (`SETTLED`), which frees the table.
  - `sales.order_bill_id` links each check to its bill; `GET /v1/restaurant/bills/:id` shows each line's paid share and quantity, the checks, and the amount paid and remaining.
- Recipe consumption is prorated with the portion: an ingredient's quantity follows the allocated fraction of the line, and the last allocation takes the remainder, so the full dish is consumed exactly once.
- Settling needs `sales.create` and the settler's own open cashier session. Servers without a drawer can bill but not settle.

### 9. Service charge
- Settings per branch (`restaurant_settings`): rate, applies to `DINE_IN` and/or `TAKEAWAY`, base, and VAT treatment.
  - Base default: items net of discounts, ex-VAT **(tax adviser)**.
  - VAT treatment default: VATABLE for VAT-registered sellers **(tax adviser)**.
- Computed by the tax engine (`serviceCharge()` in `@1pos/tax`, unit-tested) as a non-item **charge line**, never folded into item prices (RA 11360).
  - Base = Σ items' (VATable + exempt + zero-rated + percentage-tax sales − statutory discount), i.e. net of every discount, ex VAT.
  - Charge = round(base × rate). It is then taxed as one more line on its own VAT treatment: VAT added for a VAT seller, percentage-tax sales for a non-VAT seller.
- Stored on the bill (`order_bill_charges`) and on each check's sale in an append-only `sale_charges` table (base, rate, VAT treatment, buckets).
  - The sale's header buckets include the charges (Σ lines + Σ charges = header), so tax reports and drawer totals see them.
  - A check's charge follows its share of the items' amount due (an even split pays exactly half); the check that settles the bill takes the rest.
  - Returns give the charge back in proportion to the items returned (`sale_return_charges`); the return that empties the sale takes the rest.
  - Receipts print the charge on its own line.
- **Posted to a liability, not revenue**: new system account `SERVICE_CHARGE_PAYABLE` (2200), because RA 11360 requires 100 % distribution to covered employees **(accountant)**.
- SC/PWD diners' share of the service charge: computed on their discounted base and kept VATable by default. The bill carries `requiresProfessionalReview` whenever service charge and a statutory discount meet **(tax adviser — compliance Q7/Q15)**.
- Tips: not handled (separate later decision).
- Report: service charge collected per period and branch, to support DOLE distribution.

### 10. Reports and reconciliation
New reports, as built in slice 5 (`GET /v1/reports/…`, `reports.read` at the branch, not plan-gated; `RestaurantReportsService`):
- `item-performance`: menu items with their priced modifiers nested under them: quantity, net sales, revenue ex VAT, COGS (own stock or recipe), margin, and "with modifiers" totals. A modifier line counts under its item; the same variant sold alone is its own row. Free instructions have no sale line, so they are not shown.
- `ingredient-usage`, theoretical vs actual, per recipe ingredient, in quantity and value:
  - expected = recipe consumption + the ingredient sold as itself;
  - actual = expected + prepared waste (wasted voids) + other waste − count variance;
  - receipts, transfers and manual adjustments are stock coming in or corrections, so they are not use.
- `kitchen-voids`: items voided after firing, in the days they were voided. Each shows the stage reached (from the kitchen timestamps), whether it was wasted and the value of its WASTE document, by reason and by user. "Cooking started" means the kitchen marked prep, ready or served. A kitchen that cooks without tapping "in prep" shows as FIRED.
- `prep-times`: per station and overall, in seconds:
  - fired → ready: average, median, p90 and longest;
  - fired → prep started;
  - ready → served.
  Only items marked ready are timed.
- `open-orders?day=`: orders open at the close of a local day (or now, for today), each OPEN or BILLED at that moment, with what checks had paid by then. Items are counted on the order they were on at that moment (`order_item_moves`, since session 16) and as they stood then (voided or served before the cutoff).
- `service-charge`: per local day, charged − returned (ex VAT, VAT, amount due) and the distributable amount (= net ex VAT, pending the accountant). `ledger` is the `SERVICE_CHARGE_PAYABLE` credit from the same documents.

Invariants added to DOMAIN_MODEL and asserted by tests:
- **Bill = Σ checks**: per line, per bucket and for the service charge.
- **Every fired item is accounted for exactly once**: settled in a check, voided with a waste document, or voided before prep.
- **Consumption reconciles**: per ingredient, Σ `CONSUMPTION` = Σ over sale lines of quantity × recipe quantity in force.
- **The traceability audit stays clean**: `CONSUMPTION` maps to the SALE document; wasted voids are stock adjustments.

### 11. Access
Every write and the POS menu view require the `restaurant` plan feature. Reads of existing set-up do not, so data stays visible after a downgrade, and consumption at checkout never depends on the plan.
- `restaurant.manage`: menus, modifiers, tables, stations, recipes, settings.
- `restaurant.orders`: orders, fire, transfer, merge, move, bill.
- `kitchen.operate`: KDS statuses.
- `sales.void`: voids after firing.
- `sales.discount`: discounts.
- `sales.create` + an open session: settle.

All new tables are tenant-keyed with forced RLS and composite FKs, and are in the isolation matrix. Financial snapshots (`order_bills`, `order_bill_lines`, `order_bill_allocations`, `sale_charges`, `recipe_versions`, `recipe_lines`) are append-only. Operational tables (`restaurant_orders`, `order_items`, `kitchen_tickets`) are mutable under triggers and audited.

## Consequences
- Retail is unchanged except for two things. A sold variant with a recipe now consumes its ingredients. And `sale_lines` gains `parent_line_id`, while `sales` may carry charges, so the existing reports must add charges to their reconciliation: summary net = Σ by-product + Σ charges.
- Prices are fixed when the bill is printed, not when the item is ordered. A price change during service affects only unbilled orders.
- Once a check is paid, the order is locked. Late additions go on a new order for the table, which is allowed after the bill is fully settled, or requires settling first. This is accepted for now.
- Cooked food is never restocked by a return. Its cost stays in COGS, or in waste if voided before sale.
- Not in scope: delivery orders, unit conversions and purchase units, sub-recipes and prep production, rule-based modifier pricing, tips, reservations, KDS push and printers (Phase 5 device adapters).

## Slices
1. **Recipes + consumption**: versions, the `CONSUMPTION` type, SalesService and returns, posting, traceability audit, costing and ledger tests. This retires the riskiest change first, on the existing retail path.
2. **Menu foundation**: stations, areas and tables, menus and versions, modifiers, availability, restaurant settings. Schema, RLS, isolation, API and tests.
3. **Orders + kitchen**: orders and items with modifiers, fire and courses, tickets and KDS statuses, transfer, merge and move, voids with waste.
4. **Bills + checks**: bill snapshot with SC/PWD, discounts and service charge; order-mode checkout with allocations; `sale_charges` and the new account; reports reconciling with charges.
5. **Restaurant reports.**
6. **UI**: POS table service (floor, order, fire, bill, split, pay), a KDS screen, and admin for menus, modifiers, recipes, tables and settings.
7. **Exit review**: a full service-cycle scenario (SPEC "restaurant scenarios" 1–10), drills (concurrent checks on one bill, two tablets on one order, a void racing settlement), audit over dev, and design review.

## Exit review (as built, 2026-10-17)
- **Scenarios 1–10** run as one service through the real screens (`pnpm test:e2e:service`): the admin publishes the menu, sets the recipe and the service charge; the floor opens T1 and orders with choices; the KDS gets the burgers at the grill and the tea at the bar, starts and bumps; the floor sees Ready, serves, bills ₱473.00, splits evenly and takes cash and card; stock, ingredient usage, item performance, the service charge report, the trial balance and the GL figures are checked; the shift closes balanced. The API-level cycle stays in `bills.test.ts`.
- **Drills** (`restaurant-drills.test.ts`): halves at two tills at once; three thirds from one preview (the last is refused as `TOTAL_CHANGED` with its new amount, then paid); the same item at two tills; "pay the rest" by cash at one till and by card at the other (the losing card blocks the close until cancelled); a double-tapped check; reopen vs check; two tablets firing, adding and editing at once, and adding while the bill prints; a void vs the bill on four tables; two managers voiding while the kitchen readies and bumps (one void, one WASTE document); the connection killed while a check waits on the bill (503, nothing written, the same key then pays once). The lock order (session → bill → order for checks; bill → order for reopen; order first for every order change) needed no change.
- **Audit**: the traceability audit gained restaurant rules (Σ checks = settled bill, no line paid beyond the whole, no check on a voided or foreign bill, order state follows its bill), mutation-checked. Over the dev DB (`apps/api/test/dev-audit.ts`): 98 tenants, 41 migrations, 21 bills, no violations; 39 sales/returns/variances predate the ledger (accepted in Phase 3).
- **Design review**: 8 fixes, all applied. The receipt printed the service charge ex VAT next to VAT-inclusive items, so its lines did not add up to the total: it now prints the charge with its VAT and a `V` flag, and Gross is the sum of the printed lines (the sale's stored `gross` still counts the charge ex VAT, as the books do). Ingredients and sold-out items showed no name for single-variant products (now the product name), recipe lines show units, one word for a billed table ("To pay"), "New" on the KDS, the menu's publish date below its title, labelled phone rows on the service charge report, units on every usage column.

## Amendment: un-bump (session 15, 2026-10-18)
§7 said item statuses only move forward. One exception is now allowed: **READY → IN_PREP**, through `POST /v1/kitchen/tickets/:id/unbump` (`kitchen.operate`), for a station that bumped a ticket by mistake. It sends the ticket's ready items (and their choices) back to preparation, clears `ready_at`, clears the ticket's `bumped_at`/`bumped_by`, and writes `kitchen_ticket.unbumped` to the audit log. Served items never come back, and nothing goes back to FIRED or PENDING; the trigger `order_items_transition` (migration 0059) still refuses both, and the per-item status route stays forward-only. Nothing about money, stock or the bill depends on READY, so bills, checks and consumption are unaffected; prep-time reports measure from the final bump. The KDS shows "Undo bump" on a bumped ticket whose items are all ready. Tested: `orders.test.ts` ("un-bump…"), `test:e2e:kitchen`.

## Amendment: floor leftovers (session 16, 2026-10-18/19)
Migrations 0062 (DDL) and 0063 (hand-written).
- **Notes per course**: `order_course_notes` (one per order and course, 1–200 characters, live while the order is OPEN; a DB trigger refuses changes on any other status). `PUT /v1/restaurant/orders/:id/course-notes {course, note|null}` (`restaurant.orders`). Firing a course copies its note into `kitchen_tickets.course_note`, so the kitchen keeps what it was told; the order view lists `courseNotes`. Merged or moved orders keep the target's notes.
- **Voiding a choice on its own**: `POST /v1/order-items/:id/void` now also takes a fired MODIFIER (`sales.void`, Idempotency-Key). Refused when its item is voided, and with `409 CHOICE_REQUIRED` when the remaining live choices of its group would fall below the group's minimum (e.g. doneness): void the item then. `wasted` writes off only the choice's own variant. The bill and the KDS skip voided choices (the KDS strikes them). Audit `order.modifier_voided`. A pending choice is still changed by removing and re-adding its item.
- **Push to the floor and the KDS**: AFTER triggers on `restaurant_orders`, `order_items`, `kitchen_tickets`, `order_bills` and `order_course_notes` call `pg_notify('onepos_floor', '<tenant>:<branch>')` (Postgres folds identical notifications in a transaction and delivers them on commit). `FloorEvents` keeps one LISTEN connection per API process (opened by the first stream, reconnecting with backoff; after a reconnect every stream is told to re-read). `GET /v1/restaurant/stream?branchId=` (whoever may read the branch's orders or tickets) is Server-Sent Events: `ready`, then `changed` (coalesced over 150 ms), a comment every 25 s, closed after 10 minutes so the client reconnects with a fresh token. No data travels on it; clients re-read through their normal routes, so it cannot leak. The POS reads it with fetch (EventSource cannot send the bearer token) and polls every 30 s while it is up (4–8 s when it is not). Cross-tenant: tested that another business's change is not announced and that a foreign branch id answers 404.
- **Prep times by hour or item**: `GET /v1/reports/prep-times?by=station|hour|item` (default station, unchanged). `hour` = local hour the item was fired (branch timezone); day parts are ranges of hours. `item` = per variant, slowest first.
- **Open orders as they stood**: `order_item_moves` (append-only; written by a SECURITY DEFINER trigger whenever an item's `order_id` changes) lets the report place each item on the order it was on at the cutoff, and count it voided or served only if that happened before the cutoff. Moves before session 16 were not recorded; those items count where they are now (the report says so).
- **Servers without a drawer**: the POS register picker offers "Work the floor" to anyone with `restaurant.orders`: branch → floor → orders → bill, with no shift. The bill can be printed; taking money says to use a till with an open shift (the API already required a cashier session only for checks). `/v1/branches` now lists a member's branches for `restaurant.orders` too.

## Amendment: comps and changing pending items at the till (session 22, 2026-10-20)
- **Per-item discounts and comps on a bill**: `POST /v1/restaurant/orders/:id/bill` takes `itemDiscounts: [{ orderItemId, rate, reason }]` (rate up to `"1"`, a comp "on the house"). An item's own rate replaces the order-level `discountRate` for it and its priced choices (no stacking), and an item with an SC/PWD diner takes none (400). Same tax path: the rate becomes each line's `discount` in the second `computeCart` pass, so `sales.discount` is checked there, and the frozen bill lines carry it into the checks, receipts and the discounts report. The rates and reasons are in the `order.billed` audit row. No schema change. The till's bill preparation has "Discount an item" (on the house or a percentage, with a reason); the bill screen and the printed bill show each line's discount.
- **Changing a pending item at the till**: the POS calls the existing `PATCH /v1/order-items/:id` from a "Change" button on items not yet sent (quantity, course, seat, note; choices follow quantity, course and seat). Changing the choices themselves is still remove and re-add.

## Amendment: counter service, kitchen printing, tips (session 25, 2026-10-20)
The user reviewed restaurants, cafés and food trucks (`docs/INDUSTRIES.md`) and chose, each time the recommended option: pay first then fire at the counter; network ESC/POS kitchen printers driven by the desktop till; counter service offline (table service stays online-only); and all four small gaps (choices changed in place, free choices in reports, tips, no selling by weight for a restaurant). Migrations 0091 (DDL) and 0092 (hand-written).
- **Counter service** (`restaurant_settings.counter_service`, per branch; needs a takeaway menu, `COUNTER_NEEDS_MENU`): the counter's Sell screen offers the takeaway menu's choices. `POST /v1/sales` lines take `choices` (modifier option ids) and `kitchenNote`, the sale takes `pickupName`. `expandCounterLines` (`apps/api/src/restaurant/counter.ts`) puts each priced choice right after its item as its own line (option variant, item's quantity and SC/PWD share; `sale_lines.parent_line_id`); free choices go to the kitchen only. The till expands its cart the same way for the quote, so totals agree. Inside `record()`, after the books, `recordCounterOrder` writes a **COUNTER order** (`restaurant_orders.order_type = 'COUNTER'`, `sale_id`, one per sale): items fired at once by the shared `fireItems`, order OPEN → SETTLED (the transition trigger allows that for COUNTER only, and an order keeps its type and sale). The per-branch order number is the **call number** on the receipt and the KDS. Lines not on the menu sell as ordinary items. Without counter service, or when the plan/business type no longer allows the restaurant (`hasFeature`), choices are refused (`COUNTER_SERVICE_OFF`) and plain sales are unaffected. A **void** of the sale voids the kitchen items not yet handed over (`recallCounterOrder`, no waste document: recipe lines are never restocked). The KDS shows counter tickets by number and name and offers "Handed over" (SERVED).
- **Offline counter service**: the snapshot carries `counter` (menu version id, available items with groups and options, stations). The engine (`@1pos/pos-offline` `expandCounterCart`) checks min/max, prices the expanded cart, sends unexpanded lines with `choices` plus `menuVersionId`/`pickupName`, and returns the kitchen tickets, which the desktop till prints itself; the call number is the sale's device number. `recordOffline` checks the choices leniently against that immutable version (`versionMenuItems`: membership only) and records the counter order with tickets marked printed and items SERVED, so nothing appears as new in the kitchen.
- **Kitchen printing**: `kitchen_tickets.print_claimed_at/by, printed_at, print_count`. Terminal routes (`@TerminalAuth`): `GET /v1/terminal/kitchen-stations`, `POST /v1/terminal/kitchen-tickets/claim {stationIds}` (unprinted, fired in the last 12 h or reprints, unclaimed or claim older than 60 s, `FOR UPDATE SKIP LOCKED`), `…/:id/printed`, `…/:id/release`. `POST /v1/kitchen/tickets/:id/reprint` (kitchen or floor) clears `printed_at`. The desktop till maps stations to printers (Till settings → Kitchen printers, stored in the till file) and prints every 3 s while online. Tickets fired before 0092 were marked printed.
- **Tips** (pending the accountant): `tip { amount, paymentIntentId? }` on sales and checks: cash on top of the cash due, or its own card/QR intent of the same checkout (`TIP_MISMATCH`, `DUPLICATE_TENDER`). Stored in `sale_tips` (append-only), never in the amount due or the tenders (receipts print it below the payment; Z readings and tax see none of it). Posting: Dr cash/clearing, Cr `TIPS_PAYABLE` (2210, back-filled). A **void** gives the tip back in cash (`sale_returns.tip_refund`, cash movement `TIP_REFUND`); a return keeps it. Drawer movement types `TIP`, `TIP_REFUND`, `TIP_PAYOUT` (paid to staff, `tipPayoutPosting`). Report `GET /v1/reports/tips`; the traceability audit checks each tip's money. Offline sales take no tip.
- **Choices changed in place**: `PATCH /v1/order-items/:id { modifierOptionIds }` replaces a pending item's choices, checked against the menu served now.
- **Free choices** count in `item-performance` (`freeChoices`) once their order is SETTLED, in the local day it settled, unless voided.
- **Selling by weight**: `POST /v1/products` with `soldBy: WEIGHT` is refused for a RESTAURANT business (`BUSINESS_TYPE_EXCLUDES_FEATURE`, feature `sold_by_weight`).

Second round, same day (migrations 0093–0095), on the user's decisions: tips stay owed to staff without VAT (accountant to confirm); a void cancels a card tip's charge; offline tills take cash tips; an offline counter order keeps its till's call number.
- **Card tip on a void**: the void itself gives back only a cash tip (`tip_refund`). After it commits, `ReturnsService.refundTip` cancels the tip's charge with the provider (asking `retrieve` before any cash, in case an earlier cancel's answer was lost) and writes `sale_tip_refunds` (one per void): CARD (the intent goes SUCCEEDED → CANCELED, the one exception the transition trigger allows a consumed intent, and only for a TIP intent whose refund row exists), or CASH from the void's drawer, or a named open drawer, when the provider refuses. Posting: journal source `SALE_TIP_REFUND` (Dr TIPS_PAYABLE, Cr PAYMENT_CLEARING or CASH), not reversible by hand. A provider that cannot be reached leaves `tipRefundPending`; `POST /v1/sale-returns/:id/tip-refund` (`sales.void`) retries.
- **`payment_intents.purpose`** SALE | TIP: a tip's charge is never a tender (`TIP_PAYMENT_AS_TENDER`) and a sale's charge never the tip (`TIP_MISMATCH`); existing tip charges were back-filled.
- **Offline cash tips**: the envelope carries `tip { amount }`; the till's cash covers the sale and the tip; `recordOffline` records it like an online cash tip.
- **Till call number**: `restaurant_orders.till_call_number` = the offline sale's device number; the KDS, kitchen print data, receipt and sale view show it instead of the order number (`counterOrder.callNumber`).
