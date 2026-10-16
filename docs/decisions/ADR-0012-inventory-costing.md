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
8. **Negative stock** stays allowed and visible (ADR-0009); a `BLOCK` policy is a later option.

## Consequences
- COGS of a sale line = −Σ value of its `SALE` movements; gross profit is computable per sale, product and day without recomputation.
- Changing an average retroactively is impossible: corrections are new movements (e.g. a revaluation adjustment), consistent with the append-only ledger.
- Rounding: values are rounded to 4 dp per movement; the "empty takes the remainder" rule keeps zero-quantity items at zero value.
