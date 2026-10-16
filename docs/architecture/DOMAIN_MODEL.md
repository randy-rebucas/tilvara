# 1POS — Domain Model

Bounded contexts, their aggregates, invariants and state machines. Tables are in `docs/database/DATA_MODEL.md`.

## Bounded contexts

| Context | Owns | Key invariants |
|---|---|---|
| Platform | tenants, plans, subscriptions, entitlements, support grants | Entitlements checked server-side; billing failure never blocks access to legally required records or corrupts in-flight sales (grace → read-only, never delete) |
| Identity & Access | users, memberships, roles, permissions, sessions, terminals | Permission checks resolve scope: tenant → legal entity → branch → register |
| Organization | legal entities, tax profiles, branches, registers | Branch belongs to exactly one legal entity; register to one branch |
| Catalog | products, variants, categories, barcodes, UoM, tax categories | Barcodes unique per tenant among active items; products archived, never deleted once referenced |
| Pricing | price lists, product prices (versioned, effective-dated), promotions | Exactly one effective price per (price list, variant, unit) at any instant |
| Tax | tax rules (versioned), tax profiles | Each sale line stores rule version, taxable base, rate, amount |
| Checkout / Sales | checkout intents, sales, sale lines, tenders, returns | Server-computed totals; sale immutable once committed |
| Payments | payment intents, provider transactions, allocations, refunds, settlements | Sale amount ≠ tendered ≠ collected ≠ refunded ≠ settled — each tracked separately |
| Invoicing | invoice sequences, invoices, credit notes, invoice events | Numbering server-controlled, gap-auditable, per registered series |
| Inventory | items, locations, movements, balances, reservations, transfers, counts | Every stock change = a movement with a source document; balance = Σ movements |
| Purchasing | suppliers, POs, goods receipts, supplier returns | Stock increases only on goods receipt, not PO creation |
| Restaurant | menus, modifiers, areas, tables, orders, tickets, KDS, recipes | Operational order lifecycle separate from financial sale lifecycle |
| Cash | cashier sessions, cash movements, reconciliations | Expected cash = float + cash sales − cash refunds + cash-in − cash-out |
| Accounting | accounts, journal entries/lines, periods | Σ debit = Σ credit per entry; posted entries immutable; closed periods reject postings |
| Customers | customers, loyalty, store credit, consents | Marketing consent separate from transactional processing |
| Reporting | read models, exports | Every figure traceable to source rows; estimates labelled |
| Sync | terminals' sync batches/events | Idempotent on (terminal, terminal_txn_id); server re-validates |

## State machines

### Cashier session (as built, ADR-0009)
`OPEN → CLOSED (count recorded, variance ≠ 0) → RECONCILED (approved by a different user with cash.reconcile)`; a zero-variance count goes `OPEN → RECONCILED` directly. One `OPEN` session per register (DB index); no sales, payments, pay-ins/outs or refunds on a session that is not `OPEN`. Closing is refused while a card/QR payment of the session is PROCESSING, UNKNOWN or SUCCEEDED-but-unused (`PAYMENTS_OUTSTANDING`).

### Checkout
No persisted checkout state machine: a sale is one transaction (ARCHITECTURE §6). Before it commits nothing exists except quotes (read-only) and payment intents.

### Sale (financial)
`COMPLETED` is the only committed state. Corrections are separate documents (ADR-0011): `RETURN` (lines + disposition `RESTOCK | DAMAGED`) and `VOID` (whole sale, only in its own still-open session, only if nothing was returned). Both refund in cash from an open drawer of the same branch today; per-tender refunds to card/QR wait for the PayMongo adapter. The original rows are never updated or deleted.

### Payment intent (as built, ADR-0010)
`PROCESSING → SUCCEEDED | FAILED | UNKNOWN`; `UNKNOWN → SUCCEEDED | FAILED` only by provider query (reconcile; webhooks later); `SUCCEEDED → CANCELED` only while unconsumed. A sale consumes a SUCCEEDED intent once (`sale_id` stamped, unique tender). Refund intents: not built.

### Invoice
`DRAFT (never numbered) → ISSUED (number allocated, immutable) → [TRANSMITTED → ACKNOWLEDGED | REJECTED]`; cancellation/correction via credit note or cancellation event per the applicable rules — never by edit.

### Restaurant order (operational)
As built (ADR-0014 §6, §7):
- **Order**: `OPEN → BILLED → SETTLED`, `BILLED → OPEN` (bill reopened), `OPEN → CANCELLED | MERGED` (trigger). Closed orders never change. At most one live (OPEN/BILLED) order per table.
- **Order item**: `PENDING → FIRED → IN_PREP → READY → SERVED` (forward, skipping allowed) or `→ VOIDED` from any fired state. PENDING items are edited or removed; fired items are frozen.
- How far food got (sent, partly served) is derived from the items, not stored on the order.

- **Bill**: `ACTIVE → SETTLED` (the last share paid) or `ACTIVE → VOIDED` (reopened before any check; trigger).

Settling creates **Sales** (checks) via the checkout engine (`SalesService.createFromBill`). Voiding after settlement requires a Return/Refund, never an edit of the sale.

**Restaurant invariants** (asserted by `bills.test.ts`, `orders.test.ts`, `recipes.test.ts`):
1. **Bill = Σ checks**: per line, per bucket and for the service charge, centavo for centavo. A line is never paid beyond the whole (exact fractions, DB guard).
2. **Sale header = Σ lines + Σ charges** (retail sales have no charges). Returns give charges back in proportion, the last return taking the rest.
3. **Books**: Sales = items ex VAT; `SERVICE_CHARGE_PAYABLE` = Σ charges ex VAT − charges returned; output VAT includes the charge's VAT.
4. **Stock**: each dish consumes its recipe exactly once across its checks; a wasted void is one WASTE document; the traceability audit stays clean.
5. **Reports**: Σ by-product net + Σ charges net = sales summary net; a dish's COGS includes its ingredients.

### Purchase order
`DRAFT → APPROVED → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED | CANCELLED`.

### Stock transfer
`DRAFT → DISPATCHED (transfer-out movement) → RECEIVED (transfer-in movement; discrepancy recorded) | CANCELLED`. In-transit stock is visible as its own location.

### Accounting period
`OPEN → CLOSED (→ REOPENED by permission, audited)`.

## Reconciliation invariants (Phase 2, asserted by tests)

For any set of sales and returns (`sales.test.ts`, `reports.test.ts`, `reconciliation.test.ts`):
1. **Sale**: Σ line buckets = header buckets; Σ tenders applied = amount due; tendered − change = amount due; cash movement `SALE` = cash applied; electronic tenders = consumed SUCCEEDED intents of the same amount.
2. **Return**: Σ return lines = header; refund cash movement = −amount due, in the drawer that processed it; Σ returns of a line ≤ the line, and the last return takes the exact remainder (= the line, centavo for centavo).
3. **Drawer**: expected cash = Σ its cash movements (float + cash sales − refunds ± pay-in/out); the recorded `expected_cash` at close equals the ledger and nothing is added after closing. Σ over a day's drawers (minus floats) = cash collected − cash refunded in the by-tender report.
4. **Stock**: balance = Σ movements = adjustments − sold + restocked returns (DAMAGED not restocked).
5. **Reports**: summary net = Σ by-product net = Σ by-tender net = Σ tax-summary amount due = Σ sales − Σ returns from the evidence tables; days are the branch's local calendar days (tested at UTC+14 and UTC−11).
6. **Payments**: no SUCCEEDED intent is left unconsumed when a session closes; every authorized charge is either in a sale or cancelled.

## Phase 3 invariants (asserted by tests)

1. **Ledger**: per branch × item, balance quantity = Σ movement quantity and balance value = Σ movement value (`costing.test.ts`, `inventory.test.ts`, `purchasing.test.ts`).
2. **Costing**: outbound at the average, emptying takes the exact remainder; customer returns at the sale's cost; transfers arrive at the dispatch cost (ADR-0012).
3. **Purchasing**: an order line is never received beyond what was ordered, a receipt line never returned beyond what was accepted (API + DB triggers; concurrent receipts serialize on the order lock).
4. **Books**: exactly one entry per source document; every entry balances (package + deferred DB trigger); GL inventory = Σ stock values, GL in transit = open transfers, GL cash = Σ non-float cash movements + count variances, GL card clearing = Σ electronic tenders, GL output VAT = sales VAT − return VAT, GL net revenue = Σ by-product revenue ex VAT, GL COGS = Σ by-product COGS, GRNI = receipts at cost − supplier credits (`ledger.test.ts`).
5. **Traceability both ways** (Phase 3 exit review, `traceability-audit.ts`, run by `traceability.test.ts`, every drill in `inventory-drills.test.ts`, and once over the dev database): every stock movement belongs to exactly one document (sale, return, goods receipt, supplier return, transfer, count, or **stock adjustment** — a document since migration 0031); every document that moved value has exactly one entry (a zero-value document posts none); every non-manual entry names a document that exists, in the same legal entity; per document and branch, the entry's inventory lines = the value of that document's movements; goods in transit clear to zero when a transfer is received. The audit is mutation-tested (a forged entry is reported).
6. **Periods**: a posting and a close of the same month take turns (period row held `FOR SHARE` by every journal insert, migration 0032); nothing lands in a month after it was closed.

### Purchase order (as built)
`DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED → CLOSED`; `DRAFT | APPROVED (nothing received) → CANCELLED`; `PARTIALLY_RECEIVED → CLOSED` (close short with a reason). Trigger-enforced; lines editable only in DRAFT.

### Stock transfer (as built)
`DISPATCHED (TRANSFER_OUT, value into in-transit) → RECEIVED (TRANSFER_IN per line; shortfall needs a reason, its value is a transit loss)`; same legal entity only.

## Inventory policy

- Movement types (built): `SALE, RETURN, RECEIPT, SUPPLIER_RETURN, TRANSFER_OUT, TRANSFER_IN, COUNT, ADJUSTMENT, WASTE, CONSUMPTION` (Phase 4: ingredients of a sold recipe item, part of the SALE document, ADR-0014 §4). Later: `RESERVATION`/`RESERVATION_RELEASE`.
- `available = on_hand − reserved − (quarantined/damaged when tracked)`.
- Weighted average cost: on receipt `new_avg = (on_hand × avg + qty_in × unit_cost) / (on_hand + qty_in)` (when on_hand ≤ 0, avg = unit_cost). Outbound movements carry the current avg as their cost. Transfers move cost at source avg. Returns to stock at the original sale's recorded cost.
- Negative-stock policy configurable: `BLOCK | ALLOW_WITH_FLAG | ALLOW`.

## Philippine-specific domain rules (to verify — see compliance doc)

- Senior Citizen / PWD discount: 20% discount and VAT exemption on qualifying sales for the qualifying person's exclusive use; requires ID capture; modelled as a **tax treatment + discount** pair, not a plain discount. Per the research (`docs/compliance` §7, RR 5-2017): VAT seller → remove VAT first, then 20% off the VAT-exclusive price (₱1,120 → ₱1,000 → ₱800 due). Non-VAT seller → 20% off gross. One 20% discount per qualifying line (no stacking). SC/PWD log row (name, ID no., gross, discount, invoice no.) is mandatory. Group-meal proration methods are configurable (partially verified; needs professional sign-off).
- Service charge distribution (RA 11360) tracked separately from sales revenue.
- VAT-registered vs non-VAT legal entities; VAT-exempt and zero-rated lines; tax-inclusive shelf pricing typical.
