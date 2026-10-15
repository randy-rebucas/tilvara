# ADR-0011: Voids and returns as append-only documents

- Status: Accepted (2026-10-16). Cash refunds only; refunds back to card/QR wait for the PayMongo adapter (provider refund outside a transaction, same intent/reconcile pattern as ADR-0010).

## Decision
1. **The sale is never edited.** `sale_returns` + `sale_return_lines` reference the original sale lines; amounts are positive "given back" values with the same tax buckets as sales, so reports can net them.
2. **Kinds.** `VOID` reverses every line, only in the session that made the sale (still open) and only if nothing was returned yet; needs `sales.void`. `RETURN` lists lines and quantities with a disposition; needs `sales.refund`. Cashiers have neither — a manager processes it (default role templates).
3. **Exact proration.** A partial return prorates each bucket from the line's own snapshot, rounded with the sale's rounding mode; the return that empties a line takes the exact remainder. Σ returns of a line therefore equals the line, centavo for centavo (tested with ₱16.50 × 3 → 14.73/14.73/14.74 VATable). Statutory discount and VAT exemption are carried over, so an SC customer gets back what they paid.
4. **Concurrency.** Returns are serialized per sale with a transaction advisory lock (the app role cannot `SELECT … FOR UPDATE` append-only rows); a DB trigger independently refuses returning more than was sold.
5. **Money and stock.** The refund is a negative `REFUND` cash movement in an OPEN session of the same branch (the actor's own drawer, or any drawer for `cash.reconcile`); refused if the drawer lacks the cash or if the refund differs from `expectedRefund`. `RESTOCK` lines of tracked items add a `RETURN` stock movement; `DAMAGED` lines do not.
6. **Numbering.** Returns have their own gapless per-register series (`sequence_counters` name `RETURN`), separate from sale numbers, as Z-reading practice expects (PH_COMPLIANCE_ASSUMPTIONS §3).
7. **Evidence.** Audit `sale.voided` / `sale.returned`, outbox events of the same names; required Idempotency-Key.
