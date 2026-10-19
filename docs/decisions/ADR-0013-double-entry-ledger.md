# ADR-0013: Initial double-entry ledger, posted with the source document

- Status: Accepted (2026-10-16, Phase 3 slice 4). **Account mapping and posting policies are a starting point and must be reviewed by the business's accountant** (SPEC §6.8); nothing here is tax or accounting advice.

## Context
SPEC §6.8 / Phase 3 exit: stock and financial movements remain traceable and consistent; every posted entry balances; no silent edits — reversals and corrections only; periods and closing; manual adjustments under permission.

## Decision
1. **Books per legal entity** (the taxpayer). `accounts` (chart of accounts, typed ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE, optional `system_key`), `accounting_periods` (calendar months, OPEN/CLOSED), append-only `journal_entries` + `journal_lines` (debit or credit, never both, branch as a dimension).
2. **Balanced by construction and by the database.** Posting rules live in the pure `@1pos/accounting` package and refuse to produce an unbalanced entry; a deferred constraint trigger re-checks Σ debit = Σ credit (and ≥ 2 lines) at commit, whoever inserts.
3. **Posted in the same transaction as its source** (sale, return, goods receipt, supplier return, stock adjustment/waste/count, transfer dispatch/receipt, cash pay-in/out, cash count variance). A source document and its entry commit or fail together; `UNIQUE (source_type, source_id)` makes postings exactly-once. Amounts come from the evidence rows (tax buckets, tenders, stock movement values — ADR-0012), never recomputed.
4. **Periods.** Entries are dated with the source's local business date (branch timezone) and land in that month's period (created OPEN on first use). Posting into a CLOSED period is refused by a trigger. A source document whose date falls in a closed period cannot be created — in practice only possible for back-dated manual entries; operational documents are always "today". Closing needs `accounting.post`; reopening is a separate audited action.
5. **Corrections**: a manual entry (`accounting.post`, balanced, at least two lines, memo required) or a **reversal** that mirrors an entry's lines; an entry can be reversed once; posted rows are never updated or deleted.
6. **Default chart** (seeded per legal entity; codes editable later, system keys fixed):
   | key | account | posting |
   |---|---|---|
   | CASH_ON_HAND | 1010 Cash on hand | cash tenders, refunds, pay-ins/outs, count variances |
   | PAYMENT_CLEARING | 1020 Card/QR clearing | electronic tenders (until provider settlement, later) |
   | INVENTORY | 1200 Inventory | Σ stock movement values |
   | INVENTORY_IN_TRANSIT | 1210 Inventory in transit | transfers between dispatch and receipt |
   | GRNI | 2010 Goods received not invoiced | receipts at line cost; supplier returns at credit cost |
   | OUTPUT_VAT | 2100 Output VAT payable | VAT on sales, reversed on returns |
   | CASH_TRANSFERS | 3900 Cash fund transfers | drawer pay-ins/outs (owner/safe) |
   | SALES | 4000 Sales | VATable + exempt + zero-rated + percentage-tax sales (ex VAT) |
   | SALES_RETURNS | 4010 Sales returns | the same buckets on returns/voids |
   | STATUTORY_DISCOUNTS | 4020 SC/PWD discounts | statutory discount (contra-revenue) |
   | COGS | 5000 Cost of goods sold | −value of SALE movements, +value of RETURN movements, revaluations |
   | PURCHASES_NON_STOCK | 5050 Purchases – non-stock items | received services/non-tracked items |
   | PURCHASE_PRICE_VARIANCE | 5060 Purchase price variance | supplier credit ≠ value leaving stock |
   | INVENTORY_ADJUSTMENTS | 5100 Inventory adjustments | adjustments and count variances |
   | INVENTORY_WASTE | 5110 Spoilage and waste | WASTE movements |
   | TRANSIT_LOSS | 5120 Transit losses | transfer shortfalls |
   | CASH_OVER_SHORT | 5200 Cash over/short | drawer count variances |
   Opening floats are internal moves between cash and the drawer and are not posted. Ordinary discounts are already netted in the sale buckets. Purchase costs are assumed VAT-exclusive; input VAT and supplier invoices (GRNI → payables) are posted by the supplier invoice (see the session-16 amendment below; admin screens session 19). Provider fees and settlements come with the PayMongo adapter.
7. **Reports**: trial balance per entity and date range (opening, period movement, closing per account; totals equal); journal listing; source → entry traceability both ways (`source_type/source_id` on the entry).

## Consequences
- Every peso on a sale/return is in the ledger the moment it is sold: GL Sales − returns − SC discounts = report net revenue ex VAT; GL inventory = Σ stock balance values (tests assert both).
- Posting failures fail the business transaction — this is intended (no unposted sales), so the chart must always exist: it is seeded when a legal entity is created and back-filled for existing ones.

## Amendments (Phase 3 exit review, 2026-10-16)
- **Stock adjustments are documents** (`stock_adjustments`, migration 0031). A multi-item adjustment or waste used to name only its first movement as the entry's source, so the other movements could not be traced to their entry. Movements now carry `stock_adjustment_id` (DB check: ADJUSTMENT/WASTE ⇔ linked) and the entry's `source_id` is the document. Existing rows were grouped per request (tenant, branch, kind, reason, user, transaction time) and each document reuses the movement id its append-only entry already named. `GET /v1/stock/adjustments[/:id]`.
- **Closing a month and posting into it take turns** (migration 0032): the closed-period trigger now ensures the month's period row and holds it `FOR SHARE`; a close waits for postings in flight, and a posting that waited for a close is refused (`409 PERIOD_CLOSED`). Before, an entry that passed the check could commit after a concurrent close (shown by a drill that fails on the old trigger).
- **Ledger start**: documents created before migration 0028 have no entries (no historical back-posting). In dev these are 39 test documents, all older than the first entry; production starts with the ledger.
- Chart and posting rules are out for review: `docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`.

## Amendment (session 16, 2026-10-19): supplier invoices and accounts payable
Migrations 0068 (DDL) and 0069 (RLS, grants, triggers, chart back-fill). Service `PayablesService` (`apps/api/src/purchasing/payables.service.ts`).
- **New system accounts**: 1030 Cash in bank, 1300 Input VAT, 2000 Accounts payable – trade (seeded for new entities; back-filled for existing ones, as `<code>-SYS` where the entity already used the code).
- **Supplier invoice** (`supplier_invoices`, source `SUPPLIER_INVOICE`): covers whole goods receipts of one branch and one supplier (`supplier_invoice_receipts`; a receipt is on at most one open invoice). It clears the GRNI each receipt still holds (Σ received at cost less Σ credited by returns against it, rounded per line as those entries were), claims the VAT as input VAT when the entity's tax profile in force is VAT, and credits payables with the total. The difference is a purchase price variance; for a non-VAT entity that includes the VAT it paid (it is cost). Posted on the invoice date. Due date defaults to the invoice date plus the supplier's terms. Taken under the receipt's advisory lock that supplier returns use, so an invoice and a return cannot race.
- **Payment** (`supplier_payments`, append-only, source `SUPPLIER_PAYMENT`): against one invoice, under the invoice's row lock, never beyond its open balance; Dr payables, Cr cash in bank, posted on the paid-on date. Neither date may be after the branch's local today; a closed month refuses either (`PERIOD_CLOSED`).
- **Cancel**: only an unpaid invoice (OPEN → CANCELLED, trigger), with a reason. It posts a reversal of the invoice's entry and releases its receipts for a new invoice; the supplier's number may be used again.
- **Permissions**: entering and cancelling need `purchasing.manage` at the branch or `accounting.post` at the entity; paying needs `accounting.post` at the entity; lists and aging are entity-wide (`accounting.read` or entity-level `purchasing.manage`).
- **Aging** (`GET /v1/reports/payables-aging`): open balances per supplier as of a day in current / 1–30 / 31–60 / 61–90 / over 90 days past due, with the payables account balance as of that day (equal unless someone posted to it by hand).
- **Traceability**: per invoice, payables left in the books (entry, reversal, payments) = total − paid (0 if cancelled), and the GRNI cleared = Σ its receipts' matched amounts (`traceability-audit.ts`).
- Not covered yet: returns against a receipt *after* it was invoiced leave a GRNI debit until the supplier's credit note (debit/credit notes are not modelled); payments across several invoices; withholding tax (EWT, BIR 2307); a manual reversal of an invoice's entry is not prevented.
