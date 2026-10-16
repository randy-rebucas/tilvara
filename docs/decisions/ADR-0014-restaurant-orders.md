# ADR-0014: Restaurant orders, kitchen, bills and recipe consumption

- Status: Accepted for §4 (built in slice 1, 2026-10-16); the rest proposed (Phase 4 plan). Items marked **(tax adviser)** or **(accountant)** are defaults pending professional review; they are configuration or posting rules, not hard-coded law.

## Context
SPEC §6.4 / Phase 4: menus and versions, modifiers (required/optional, priced), areas and tables, dine-in and takeaway orders, table transfer, merge and split, kitchen tickets routed to stations, KDS with preparation statuses, courses, item voids, split bills and split payments, service charge and discounts, versioned recipes with ingredient consumption and waste, restaurant reports. Exit: *a restaurant completes a full service cycle and reconciles its stock, payments and financial records.*

Hard rules carried in: "an open table or kitchen ticket is not a finalized sale"; "cancelling a kitchen item never rewrites a settled transaction"; checkout only via `SalesService.create` with server recompute (ADR-0009); stock only through `stock_movements` costed by the trigger (ADR-0012); one journal entry per document (ADR-0013); the traceability audit stays clean.

What exists: `restaurant.manage`, `restaurant.orders`, `kitchen.operate` permissions (branch manager and cashier templates already hold some) and a `restaurant` plan feature. No composite, modifier or recipe concept; one UoM per product, no conversions; stock per branch.

## Decision

### 1. Menu items are catalog items
A dish, a drink and a priced add-on are **product variants** (usually `track_inventory = false`). Price, tax category and VAT treatment come from the existing price lists and tax path, so there is still one place a price lives and one tax engine. Menus decide *what is offered where and how it is routed*, never the price.

### 2. Menus and versions
- `menus` (tenant), assigned to branches via `branch_menus` (one active menu per branch and order type).
- `menu_versions`: `DRAFT → PUBLISHED → RETIRED`; a published version is immutable (trigger) and exactly one is published per menu. Editing = copy to a new draft, publish (retires the old one atomically).
- `menu_sections` and `menu_items` belong to a version: variant, section, sort, **kitchen station** for routing, attached modifier groups.
- **86 / sold out**: `menu_item_availability` per branch (mutable flag, audited), outside the version so it changes mid-service without republishing.
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
- `order_items`: variant, quantity, course (1..n, default 1), seat (optional), note, parent item for modifier lines, modifier option, station, `menu_version_id`. Prep status: `PENDING` (not yet fired) → `FIRED` → `IN_PREP` → `READY` → `SERVED`, or `VOIDED`.
  - A trigger enforces the status machine and freezes variant, quantity and modifiers once fired.
  - `PENDING` items may be edited or removed. A fired item can only be voided.
- **Voids after firing** need `sales.void` and a reason. If preparation had started (`IN_PREP` or later), the void may be marked *wasted*. A wasted void writes a `WASTE` stock adjustment of the item's recipe quantities in the same transaction, so it is costed, posted to Spoilage and waste and traceable through the existing document.
- Mutations lock the order row (`FOR UPDATE`). Adding items requires an Idempotency-Key (tablet retries must not double an order).
- **Transfer** a table: move the order to a free table. **Merge**: move all live items of B into A; B becomes `MERGED`. **Move items**: selected items (with their modifier children) go to another or new order. All are recorded in the audit log.

### 7. Kitchen tickets and KDS
- **Fire** sends the order's `PENDING` items of the chosen courses (default: all not held). It groups them by station into `kitchen_tickets` (per-branch number, station, course, fired_at, fired_by). Re-firing with nothing pending is a no-op, so it is safe to retry.
- **KDS**: `GET /v1/kitchen/tickets?stationId&since=` (cursor polling, ~3 s; push via SSE is a later option). Item status changes come from `kitchen.operate`, and "bump" moves a whole ticket to READY. Prep times (fired → ready) are kept for reports.
- Courses: items carry a course number. Later courses can be held and fired on demand.

### 8. Bills: freeze, then settle in one or more checks
- **Bill** (`POST /orders/:id/bill`, `restaurant.orders`). The server runs `TaxService.computeCart` over the order's live items: modifier children, SC/PWD assignments per item (itemized, or a headcount share via the engine's existing `share`), ordinary discounts (`sales.discount`; an order-level percentage is spread over the lines and skips statutory lines, which refuse stacking), and the service charge.
- The result is stored as an immutable `order_bills` + `order_bill_lines` snapshot, and the order becomes `BILLED`; adding items is then refused. The bill can be **reopened** (voided, back to `OPEN`) only while no check is settled. This fixes prices and tax for the whole table even if a price changes mid-service, and is what the guest sees on the printed bill.
- **Checks** settle the bill. `POST /v1/sales` gains an order mode: `{ cashierSessionId, clientTransactionId, orderBillId, allocations: [{ billLineId, portion }], tenders, expectedAmountDue }`. Portion is a whole quantity or an even share n/d.
  - The sale's lines are the bill lines' buckets prorated exactly as returns are (ADR-0011): `round2(bucket × portion)` per bucket, and the allocation that completes a bill line takes the exact remainder. Σ of the checks therefore equals the bill, centavo for centavo.
  - `order_bill_allocations` plus a DB within-bill guard (as `sale_return_lines` has) stop over-allocation under concurrency. The order row lock serialises checks.
  - Each check is an ordinary **Sale**: its own number, tenders (split payment), receipt, cash movement, consumption, journal entry, and returns. Everything else in ADR-0009 (Idempotency-Key, duplicate `clientTransactionId`, stale-total refusal, one transaction) is unchanged.
  - "Split evenly by N" is N checks of share 1/N on every line.
  - The order becomes `SETTLED` when every bill line is fully allocated.
- Recipe consumption is prorated with the portion: an ingredient's quantity follows the allocated fraction of the line, and the last allocation takes the remainder, so the full dish is consumed exactly once.
- Settling needs `sales.create` and the settler's own open cashier session. Servers without a drawer can bill but not settle.

### 9. Service charge
- Settings per branch (`restaurant_settings`): rate, applies to `DINE_IN` and/or `TAKEAWAY`, base, and VAT treatment.
  - Base default: items net of discounts, ex-VAT **(tax adviser)**.
  - VAT treatment default: VATABLE for VAT-registered sellers **(tax adviser)**.
- Computed by the tax engine as a non-item **charge line**, never folded into item prices (RA 11360).
- Stored on the bill and on each check's sale in an append-only `sale_charges` table (base, rate, amount ex VAT, VAT, amount due), prorated across checks like lines.
- **Posted to a liability, not revenue**: new system account `SERVICE_CHARGE_PAYABLE` (2200), because RA 11360 requires 100 % distribution to covered employees **(accountant)**.
- SC/PWD diners' share of the service charge: computed on their discounted base and kept VATable by default. The bill carries `requiresProfessionalReview` whenever service charge and a statutory discount meet **(tax adviser — compliance Q7/Q15)**.
- Tips: not handled (separate later decision).
- Report: service charge collected per period and branch, to support DOLE distribution.

### 10. Reports and reconciliation
New reports:
- item performance (menu items with their modifiers: quantity, net, COGS, margin);
- theoretical vs actual ingredient usage (consumption vs count variance and waste);
- voids after firing (wasted or not, by reason and user);
- kitchen prep times per station;
- open orders at close of day;
- service charge collected.

Invariants added to DOMAIN_MODEL and asserted by tests:
- **Bill = Σ checks**: per line, per bucket and for the service charge.
- **Every fired item is accounted for exactly once**: settled in a check, voided with a waste document, or voided before prep.
- **Consumption reconciles**: per ingredient, Σ `CONSUMPTION` = Σ over sale lines of quantity × recipe quantity in force.
- **The traceability audit stays clean**: `CONSUMPTION` maps to the SALE document; wasted voids are stock adjustments.

### 11. Access
Every route requires the `restaurant` plan feature.
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
