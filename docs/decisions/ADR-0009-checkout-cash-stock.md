# ADR-0009: Checkout, cashier sessions and the stock ledger

- Status: Accepted (2026-10-16). Cash tender only; non-cash payments get their own ADR (payment intents, provider boundary).

## Decision
1. **One transaction per sale** (`POST /v1/sales`): lock the cashier session row → verify it is OPEN and owned by the caller → recompute prices and taxes through the same `TaxService.computeCart` path as `/v1/tax/quote` → number → write sale, beneficiaries, lines, tenders, the drawer movement, stock movements, audit row and outbox event. Any refusal rolls everything back (tests assert no rows and no consumed number).
2. **Duplicate protection, two layers**: a required `Idempotency-Key` (retries replay the stored response, concurrent duplicates serialize on the idempotency row) and a terminal `clientTransactionId` unique per register (a re-sent checkout under a new key is refused with `DUPLICATE_TRANSACTION`, which also prepares offline sync).
3. **Stale totals**: the client may send `expectedAmountDue`; if the server total differs the sale is refused with `TOTAL_CHANGED` and the new amount.
4. **Numbering**: gapless per-register sale numbers from `sequence_counters` (upsert under row lock in the sale transaction, so a rollback returns the number). This is the internal transaction series; invoice series remain disabled until the compliance gate.
5. **Cash**: `cashier_sessions` (one OPEN per register; OPEN → CLOSED → RECONCILED by trigger), append-only `cash_movements` (opening float, sale net cash, pay-in/out with reason), expected cash = Σ movements. Close records a `cash_reconciliations` row; zero variance reconciles immediately, otherwise a different user with `cash.reconcile` approves once (DB check forbids self-approval).
6. **Stock**: append-only `stock_movements` (sales −qty per tracked line; adjustments with reason); `stock_balances` is maintained by a SECURITY DEFINER trigger and is read-only to the app, so balance = Σ movements by construction. Negative stock is allowed and visible (policy configurable later).
7. **Statutory discounts at checkout** need a beneficiary (name + ID number only — no disability data) per scheme; in production, schemes still `PENDING_PROFESSIONAL_REVIEW` are refused (`SCHEME_PENDING_REVIEW`).
8. **Effective dating uses the DB clock with a 5-second skew allowance** (`apps/api/src/common/clock.ts`): the DB clock steps backwards on VM/NTP resync (≈0.9 s observed), which made just-created profiles and prices intermittently "not yet in force". A change can therefore take effect at most 5 s before its timestamp; sales snapshot what they used.

## Consequences
- Every sale reconciles by construction and by test: Σ lines = sale totals, Σ tenders applied = amount due, tendered − change = due, drawer movement = due, stock movement = −quantity for tracked items.
- Voids, returns and refunds will be separate append-only documents referencing the sale.

## Amendment: Z-readings (session 16; fiscal gate G2, not BIR-accredited)
- `z_readings` (migrations 0066/0067, append-only): one reading per register per local business day (branch time zone), taken by `cash.reconcile` through `POST /v1/registers/:id/z-readings`. Refused while a shift is open on the register (`409 SHIFT_OPEN`), for a day not started (`422 DAY_NOT_STARTED`), and for a day on or before the register's last reading (`409 Z_READING_ORDER`; readings go forward).
- It numbers per register (`z_number`), records the first and last sale numbers, the sale buckets, returns and voids (their own series, ADR-0011 §6), net = sales − returns − voids, tenders net of refunds, statutory discounts by scheme, and the accumulated grand total = previous + net (never reset; `reset_counter` stays 0). Check constraints hold both equations. A transaction advisory lock per register serialises readings.
- Day windows use the branch's local midnight, so one shift across midnight puts its sales into two readings while its shift report stays one (tested with backdated rows: the "session spanning local midnight" gap of the Phase 2 review).
- The official field format, the grand-total digit length and what a reading must show are tax-adviser questions (PH_COMPLIANCE_ASSUMPTIONS §5); the screens say the readings are the business's own records, not BIR-accredited. Offline sales delivered after their day's reading are not in it (open item in LEFTOVER).
