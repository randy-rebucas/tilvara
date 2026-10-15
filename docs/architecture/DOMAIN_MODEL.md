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

### Cashier session
`OPEN → CLOSING (count submitted) → CLOSED → RECONCILED` (manager approval if variance > threshold). No sales on a session not `OPEN`.

### Checkout intent
See ARCHITECTURE §6.

### Sale (financial)
`COMPLETED` is the only committed state. Corrections are separate documents: `Return` (lines + disposition RESTOCK/DAMAGED/NO_RETURN), `Refund` (money back, per tender), `Void` (same-session full reversal with manager authorization, still a separate reversal record — the original row is never deleted).

### Payment intent
`CREATED → PENDING → (AUTHORIZED) → CAPTURED | FAILED | CANCELLED | UNKNOWN`; `UNKNOWN` resolves only by provider query/webhook. Refund: `REQUESTED → PENDING → SUCCEEDED | FAILED`.

### Invoice
`DRAFT (never numbered) → ISSUED (number allocated, immutable) → [TRANSMITTED → ACKNOWLEDGED | REJECTED]`; cancellation/correction via credit note or cancellation event per the applicable rules — never by edit.

### Restaurant order (operational)
`OPEN → SENT (tickets fired) → PARTIALLY_SERVED → SERVED → BILL_REQUESTED → SETTLED | CANCELLED`.
Ticket item: `QUEUED → IN_PREP → READY → SERVED | VOIDED`. Settling creates a **Sale** via the checkout engine; voiding a ticket item after settlement requires a Return/Refund, never an edit of the sale.

### Purchase order
`DRAFT → APPROVED → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED | CANCELLED`.

### Stock transfer
`DRAFT → DISPATCHED (transfer-out movement) → RECEIVED (transfer-in movement; discrepancy recorded) | CANCELLED`. In-transit stock is visible as its own location.

### Accounting period
`OPEN → CLOSED (→ REOPENED by permission, audited)`.

## Inventory policy

- Movement types: `RECEIPT, SALE, RECIPE_CONSUMPTION, CUSTOMER_RETURN, SUPPLIER_RETURN, WASTE, ADJUSTMENT, TRANSFER_OUT, TRANSFER_IN, COUNT_VARIANCE, RESERVATION, RESERVATION_RELEASE`.
- `available = on_hand − reserved − (quarantined/damaged when tracked)`.
- Weighted average cost: on receipt `new_avg = (on_hand × avg + qty_in × unit_cost) / (on_hand + qty_in)` (when on_hand ≤ 0, avg = unit_cost). Outbound movements carry the current avg as their cost. Transfers move cost at source avg. Returns to stock at the original sale's recorded cost.
- Negative-stock policy configurable: `BLOCK | ALLOW_WITH_FLAG | ALLOW`.

## Philippine-specific domain rules (to verify — see compliance doc)

- Senior Citizen / PWD discount: 20% discount and VAT exemption on qualifying sales for the qualifying person's exclusive use; requires ID capture; modelled as a **tax treatment + discount** pair, not a plain discount. Per the research (`docs/compliance` §7, RR 5-2017): VAT seller → remove VAT first, then 20% off the VAT-exclusive price (₱1,120 → ₱1,000 → ₱800 due). Non-VAT seller → 20% off gross. One 20% discount per qualifying line (no stacking). SC/PWD log row (name, ID no., gross, discount, invoice no.) is mandatory. Group-meal proration methods are configurable (partially verified; needs professional sign-off).
- Service charge distribution (RA 11360) tracked separately from sales revenue.
- VAT-registered vs non-VAT legal entities; VAT-exempt and zero-rated lines; tax-inclusive shelf pricing typical.
