# Request for review: default chart of accounts and posting rules

**To:** a Philippine CPA familiar with retail and VAT bookkeeping
**From:** the Tilvara team · **Date:** 2026-10-16 · **Decision record:** ADR-0013 (`docs/decisions/ADR-0013-double-entry-ledger.md`), costing ADR-0012

Tilvara is a point-of-sale and back-office system for small Philippine shops. Every sale, return, goods receipt, supplier return, stock count, adjustment, transfer and drawer movement posts one balanced journal entry automatically, in the same database transaction as the document. We want an accountant to confirm or correct the default chart and the posting rules before any customer relies on these books. **Nothing here is presented to customers as BIR-compliant**; this review is one step toward that.

What we ask: for each numbered question, "agree", "change to …", or "needs a decision by the business". Comments on anything else are welcome.

## 1. Default chart (seeded for every legal entity; the business can add accounts)

| Code | Account | Type | Used by |
|---|---|---|---|
| 1010 | Cash on hand | Asset | cash sales, refunds, pay-in/out, drawer variance |
| 1020 | Card/QR clearing | Asset | card, QR and e-wallet sales (until the provider settles) |
| 1200 | Inventory | Asset | every stock movement, at moving-average cost |
| 1210 | Inventory in transit | Asset | transfers dispatched and not yet received |
| 2010 | Goods received not invoiced (GRNI) | Liability | goods receipts; supplier returns |
| 2100 | Output VAT payable | Liability | sales; returns |
| 3900 | Cash fund transfers | Equity | drawer pay-in / pay-out |
| 4000 | Sales | Revenue | sales, net of VAT, before SC/PWD discounts |
| 4010 | Sales returns | Revenue (contra) | returns and voids |
| 4020 | SC/PWD discounts | Revenue (contra) | statutory senior-citizen / PWD discounts |
| 5000 | Cost of goods sold | Expense | sales; restocked returns; revaluations |
| 5050 | Purchases – non-stock items | Expense | services and untracked items received |
| 5060 | Purchase price variance | Expense | supplier credit ≠ average cost on returns |
| 5100 | Inventory adjustments | Expense | counts and manual adjustments |
| 5110 | Spoilage and waste | Expense | waste |
| 5120 | Transit losses | Expense | goods short on a received transfer |
| 5200 | Cash over/short | Expense | drawer count variance |

## 2. Posting rules (Dr = debit, Cr = credit; zero lines are dropped)

| Document | Entry |
|---|---|
| Sale | Dr Cash (cash collected) · Dr Card/QR clearing (electronic) · Dr SC/PWD discounts · Cr Sales (ex VAT) · Cr Output VAT · Dr COGS / Cr Inventory (at average cost) |
| Return or void (cash refund) | Dr Sales returns (ex VAT) · Dr Output VAT · Cr SC/PWD discounts · Cr Cash (refund) · Dr Inventory / Cr COGS (restocked goods only; damaged goods are not restocked) |
| Goods receipt | Dr Inventory (ledger value) · Dr COGS (receipt cost − ledger value: revaluation of units sold before they were received) · Dr Purchases non-stock · Cr GRNI (quantity × receipt cost) |
| Supplier return | Dr GRNI (supplier's credit) · Cr Inventory (at average) · Cr Purchases non-stock · Dr/Cr Purchase price variance (average − credit) |
| Count, adjustment | Dr/Cr Inventory · Cr/Dr Inventory adjustments (counted − on hand, at average) |
| Waste | Cr Inventory · Dr Spoilage and waste |
| Transfer dispatched | Dr Inventory in transit / Cr Inventory (source branch, at average) |
| Transfer received | Dr Inventory (destination) · Dr Transit losses (short quantity at dispatch cost) · Dr/Cr COGS (destination revaluation) · Cr Inventory in transit |
| Drawer pay-in / pay-out | Dr/Cr Cash · Cr/Dr Cash fund transfers |
| Drawer count variance | Dr/Cr Cash · Cr/Dr Cash over/short |
| Manual entry, reversal | as entered; a reversal mirrors the original once, and both stay in the books |

Policies: moving-average cost per branch and item; negative stock is allowed and visible, and a later receipt revalues it into COGS; months are open until closed, a closed month accepts no postings and needs a reason to reopen; entries are never edited.

## 3. Questions

> Update 2026-10-19: questions 1 and 2 were built as proposed (supplier invoices clear GRNI to Accounts payable, input VAT to an Input VAT asset, the difference to purchase price variance; ADR-0013 amendment). Your answers still decide whether that stays.

1. **GRNI instead of Accounts payable.** Supplier invoices are not recorded yet, so receipts credit GRNI and stay there. Acceptable as an interim? When invoices arrive, should we move GRNI → AP at invoice amount and post the difference to purchase price variance?
2. **Input VAT.** Receipts are booked at cost without input VAT (it belongs to the supplier invoice, not yet modelled). Is that right for a VAT-registered buyer until invoices exist, and which account should input VAT use (e.g. "Input VAT" asset, with deferred input VAT on capital goods out of scope)?
3. **SC/PWD discounts** are a contra-revenue account (4020) and the sale is recorded at the full price ex VAT. Is this the presentation you expect, versus recording the sale net of the discount? Any separate tracking needed for the deductibility of the discount for income tax?
4. **Revaluation to COGS** when a receipt arrives after units were sold short: is COGS the right home, or should it go to a purchase price variance / inventory adjustment account?
5. **Card/QR clearing**: provider fees and settlements are not modelled yet (they will move clearing → bank, fees → expense). Any objection to the clearing-account approach?
6. **Cash fund transfers (equity)** for drawer pay-in/pay-out: the drawer's change fund comes from and returns to the owner or the bank. Would you prefer a "Cash in bank" or "Petty cash" counterpart, or an expense when the pay-out is a purchase (e.g. ice)?
7. **Transit losses and waste** as expenses: any BIR documentation the business must keep for these to be deductible (e.g. notice of destruction for spoiled goods)?
8. **Non-VAT (percentage tax) sellers**: sales are credited at the full price and no output VAT is posted; percentage tax is not accrued. Should we accrue percentage tax monthly?
9. **Period close** is per legal entity and month. Is that sufficient, or do you need a year-end close (income summary to retained earnings) in the product?
10. **Account numbering** (1xxx assets … 5xxx expenses): fine as a default for small PH retailers?
11. **Store credit (session 20, ADR-0018).** A return refunded as store credit posts like a cash refund but credits *2300 Customer store credit* (liability) instead of cash; spending it debits that account instead of cash. Output VAT is reversed when the goods come back and charged again on the sale that uses the credit. Is that the right VAT treatment? Should unspent credit ever expire (breakage income), and if so after how long? Is one liability account per legal entity enough, or do you need it per branch?
12. **Supplier credit and debit notes, payment voids (session 22, ADR-0013 amendment).** A supplier's credit note against an invoice debits AP, credits input VAT (VAT entities), credits GRNI up to what returns made after invoicing left there, and credits purchase price variance with the rest; a debit note is the reverse against PPV. A mistaken supplier payment is voided by reversing its entry on the void date (not the payment date). Is crediting PPV right for allowances (versus reducing inventory cost of goods still on hand)? Is reversing a void on the void date acceptable for a closed month, or must the original month be reopened? Should a credit note be tied to a specific return document for your audit trail?

13. **Returns of a sale paid partly with store credit (2026-10-21).** Store credit is never refunded as cash. When a sale paid partly with store credit (2300) and partly with cash is returned, the refund goes back to credit in the same proportion as the sale was paid, and the rest goes out as cash. Example: a ₱1,000 sale paid ₱400 credit and ₱600 cash; returning half (₱500) gives ₱200 back as credit and ₱300 in cash. Over all the sale's returns, no more credit comes back than was used. The alternative is credit first: give back up to ₱400 as credit before any cash. Which do you prefer?

## 4. What we will do with your answers
Each answer becomes either a change to `@1pos/accounting` (with tests) or a recorded decision in ADR-0013. Nothing changes in posted books retroactively: corrections are made by new entries.
