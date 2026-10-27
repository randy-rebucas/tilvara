# ADR-0012: Weighted-average inventory costing in the stock ledger

- Status: Accepted (2026-10-16, Phase 3 slice 1). Accounting policy choices below need sign-off by the business's accountant before production use (SPEC §6.8).

## Context
Phase 2 built an append-only `stock_movements` ledger with trigger-maintained `stock_balances` (quantity only). Phase 3 needs inventory valuation, cost of goods sold and, later, journal postings. SPEC §10: weighted-average costing initially; document how purchases, returns, waste, transfers and consumption affect valuation; concurrent checkout must not corrupt balances.

## Decision
1. **Where**: per (branch, variant). `stock_balances` gains `value` (NUMERIC 20,4) and `avg_cost`; every `stock_movements` row gains `unit_cost` and `value` (signed, NUMERIC 20,4). Invariant: **`balance.value = Σ movement.value`** and `balance.quantity = Σ movement.quantity`, per item, always.
2. **Who computes**: the `BEFORE INSERT` trigger on `stock_movements` (SECURITY DEFINER, owned by `onepos_platform`) locks the balance row (`FOR UPDATE`), computes the movement's cost and value, and updates the balance — one place, under one lock, unforgeable by the app role. Services supply a unit cost only for inbound movements they own the cost of.
3. **Outbound** (quantity < 0: `SALE`, negative `ADJUSTMENT`, `WASTE`, `TRANSFER_OUT`, `SUPPLIER_RETURN`, `COUNT` shortage): `unit_cost` = current `avg_cost` (any app-supplied cost is overwritten); `value = round4(quantity × avg)`, except an outbound that brings quantity to exactly 0 takes the exact remaining value (no residue). `avg_cost` is unchanged.
4. **Inbound** (quantity > 0) at cost `c`:
   - `RECEIPT` (goods receipt line cost) and positive `ADJUSTMENT` (cost given, else the last average if any, else the variant's reference cost, else 0): the service passes `c`; a missing cost is refused by the trigger.
   - Looked up by the trigger: `RETURN` (customer) at the unit cost of the original `SALE` movement of that line, so a return reverses the COGS it came with; `TRANSFER_IN` at the unit cost its `TRANSFER_OUT` left the source with; a `COUNT` surplus at the last average, else the reference cost, else 0.
   - `COUNT` movements carry no quantity from the app: the trigger sets `quantity = counted − on hand` under the balance lock at posting time (no row when equal), so a sale cannot slip between reading the balance and posting the variance. Counts are therefore posted when counting finishes (blind counts with later posting are a future option).
   - With quantity on hand > 0 before: `value += q × c`, `avg = value / quantity` (4 dp).
   - With quantity ≤ 0 before (negative stock was allowed and costed at the old average): the item restarts at `avg = c`, `value = new quantity × c`; the movement's `value` is whatever keeps the invariant (`value_after − value_before`). The difference from `q × c` is a visible **revaluation** of units sold short (`value − quantity × unit_cost`), posted to COGS adjustments by accounting.
5. **Supplier returns** leave at the current average, not the purchase price; any difference to the supplier credit is a purchase price variance for accounting (Phase 3 slice 4).
6. **Legacy rows** (Phase 2, before costing): backfilled at the variant's `reference_cost` (else 0); balances recomputed from the ledger.
7. **Lock order**: a document touching several items inserts its movements sorted by variant id, so two concurrent documents lock balance rows in the same order (no deadlock).
8. **Negative stock** stays allowed and visible (ADR-0009); a `BLOCK` policy is a later option. *(Replaced by the session-16 amendment below.)*

## Consequences
- COGS of a sale line = −Σ value of its `SALE` movements; gross profit is computable per sale, product and day without recomputation.
- Changing an average retroactively is impossible: corrections are new movements (e.g. a revaluation adjustment), consistent with the append-only ledger.
- Rounding: values are rounded to 4 dp per movement; the "empty takes the remainder" rule keeps zero-quantity items at zero value.

## Amendment (session 16): negative-stock policy, stock alerts, count sheets
Migrations 0060 (DDL) and 0061 (hand-written). Decision 8 is replaced by:

8. **Negative stock is a per-branch policy** (`inventory_settings.negative_stock_policy`; a branch without a row is `ALLOW`, as before). Only `org.manage` changes it (audited `inventory.settings_updated`).
   - `ALLOW`: sell below zero; the balance shows it.
   - `ALLOW_WITH_FLAG`: the same, plus an alert when an item crosses from ≥ 0 to < 0.
   - `BLOCK`: a **counter sale** (`SalesService.create`, `enforceStock`) is refused with `409 INSUFFICIENT_STOCK` (`details.lines[]`: variant, name, on hand, requested) when any tracked line would take its item below zero; nothing is written. The balance rows are locked first by `app_lock_stock_balances(branch, variants[])` (SECURITY DEFINER: the app may not lock a table it cannot update), in variant order, the order the costing trigger locks them a moment later, so two tills cannot both sell the last unit (test: three rounds of two simultaneous sales, exactly one passes each time; reading without the lock lets both through). A restaurant check pays for food already served and an offline sale has already been handed over: neither is refused for stock under any policy; they are flagged like `ALLOW_WITH_FLAG`. Recipe consumption (`CONSUMPTION`) is never blocked.
   - *Amendment (2026-10-25): restaurant checks and recipes were withdrawn (migrations 0111, 0112). Of the exceptions above only the offline sale remains: it is flagged, never refused.*
   - Every outbound movement that leaves its balance below zero has `stock_movements.below_zero = true`, set by the costing trigger whatever the policy (a fact, not a decision). The stock movements report counts them per item in the range.

9. **Stock alerts come from the costing trigger**, which alone sees the quantity before and after under the balance lock, for every kind of document (sales, offline sales, waste, transfers, counts). It inserts outbox events in the movement's transaction (`onepos_platform` was granted INSERT on `outbox_events`):
   - `stock.low` when a balance falls from above its reorder point to at or below it, if the branch's `low_stock_alerts` is on (default on). Once per crossing: it fires again only after the item recovers above the point.
   - `stock.below_zero` when a balance crosses from ≥ 0 to < 0 and the policy is not `ALLOW`.
   The worker mails each active member holding `inventory.adjust` or `purchasing.manage` for the business, the branch's entity or the branch (`stockKeepers`, `stockAlertMail` in `@1pos/database`; tested as `onepos_worker`, including that another business's worker context sees nobody).

10. **Count sheets** (blind counts): `stock_count_sheets` (OPEN → POSTED | CANCELLED once, DB trigger; a cancel needs a reason) and `stock_count_sheet_lines` (frozen `expected_quantity`; counts only while the sheet is open, DB trigger with the sheet `FOR SHARE`).
    - Opening (`inventory.adjust`) freezes on hand for every stock-tracked item with a balance at the branch (at most 5,000; else by list) in one `INSERT … SELECT`, one snapshot.
    - Counting needs the new permission `inventory.count` (or `inventory.adjust`). On a blind sheet, someone without `inventory.adjust` never receives the frozen quantities from the API (`expectedShown: false`) until it is closed; the admin also hides them from adjusters until asked. An item found that is not on the sheet is added, frozen at on hand when added.
    - Posting (`inventory.adjust`, Idempotency-Key required) writes one ordinary stock count whose lines carry `expected_quantity`; for such a line the trigger moves `counted − expected` instead of `counted − on hand`. Stock that moved since the freeze (sales while people counted) therefore stays on the books: frozen 10, 2 sold, 9 counted → −1 → 7 on hand. Uncounted lines are not posted. The sheet view shows each line's net movement since the freeze so the reviewer sees what the posting keeps.
    - Known limit: a sale whose transaction started before the freeze and committed after it is in neither the frozen quantity nor "moved since the freeze" (its `created_at` is its transaction start). Freeze when the tills are quiet.
    - `inventory.count` is held by the owner and admin templates (back-filled into every business by 0061) and can be put in custom roles (e.g. a stock counter). Branch lists and the Inventory tab open for it.

## Amendment 3 (audit 45, 2026-10-27): count sheets post against the book when counted
Migrations 0134 (DDL) and 0135. Replaces the posting rule and the known limit of decision 10 above (the session-16
amendment's count sheets; this is the third change to the costing rules, after the original decisions and that
amendment).

- **Why.** "Counted − frozen" assumed a count tells what was on the shelf at the freeze. It tells what is on the
  shelf when the line is counted. Frozen 10, one sold after the freeze, the shelf counted 9: the old rule posted −1
  as shrink on top of the sale (the unit left twice). Offline sales rung before the freeze but delivered after it
  were in neither number.
- **Order of movements.** The costing trigger numbers each balance's movements under the balance lock
  (`stock_balances.movement_seq`, copied to `stock_movements.balance_seq`; NULL for movements before 0134). The
  freeze locks the balances (`app_lock_stock_balances`) and keeps the number on each line (`frozen_seq`), so a
  movement in flight is either in the frozen quantity (it committed first) or numbered after it. The old known
  limit (a sale starting before the freeze and committing after it) is gone.
- **Rule.** Posting locks the balances again and posts, for each counted line,
  `counted − (frozen + Σ movements with balance_seq > frozen_seq whose stock moved by counted_at)`; that book
  quantity is the count line's `expected_quantity` (the trigger is unchanged: `counted − expected`). "When the
  stock moved" is the sale's `completed_at` for a sale and for packs a sale opened (an offline sale counts when it
  was rung, not when it was delivered), else when the movement was recorded.
  - A sale after the freeze and before the count: in the book, deducted once (frozen 10, 1 sold, counted 9 → 0).
  - An offline sale rung before the freeze, delivered after it: never in the frozen figure, rung before the count,
    so in the book (frozen 10 though the shelf had 9, counted 9 → 0).
  - A sale rung after the count (delivered before the posting or not): not in the book; its own movement takes
    the unit off (counted 9 → +0, then −1).
  - Limit: a sale rung before the count but delivered after the sheet posts cannot be known then: it shows as
    shrink at the count and is deducted again when it arrives. Post a sheet once the tills have synced.
  - Lines frozen before 0134 (`frozen_seq` NULL) use the movements recorded after the sheet's freeze.
- **What the reviewer sees.** The sheet view's "moved since the freeze" is the same sum up to when the line was
  counted (up to now for a line not counted yet), and its variance is `counted − frozen − moved`, the number
  posting will use. The count document's "system quantity" is that book quantity.
- **Locks.** Adding an item to an open sheet takes the branch's counting lock first, like a quick count, so a quick
  count of the same item either finishes first (and is in the frozen figure) or sees the item on the sheet.
