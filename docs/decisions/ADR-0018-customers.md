# ADR-0018: Customers, marketing consent and store credit

- Status: Accepted (2026-10-20, session 20). The user chose to build store credit now and flag it for the accountant (question 11 of the accountant review request), rather than wait. Customer accounts receivable (sales on account, statements, payments) are not built.
- SPEC §6.9 (customer management), §6.3 (customer association), §12 privacy. Builds on ADR-0009 (checkout), ADR-0011 (returns), ADR-0013 (ledger).

## Decision
1. **A customer is business-wide master data**, like a supplier. `customers` holds a name (required) and optionally a number, phone, email, TIN, address and notes; nothing else is collected (privacy pack, processing register §15). `customers.read` at any scope searches and opens customers; `customers.manage` creates, corrects, exports and anonymises them. Cashiers hold `customers.read` (they put existing customers on a sale); adding customers at the till needs `customers.manage` (branch managers). Changing the cashier template is the user's call (LEFTOVER).
2. **Marketing consent is its own yes/no**, never a condition of a sale. Every change is kept in the append-only `customer_consent_events`, with how it was given (COUNTER, ADMIN, REQUEST) and who recorded it. Withdrawing needs only `customers.read`, so a "stop" never waits for a manager; giving needs `customers.manage`.
3. **Corrections overwrite the profile.** They are audited by field name only: the audit log never becomes a second copy of personal data. **Anonymising** blanks every personal field for good: the name becomes "Anonymised customer" and the row is archived. A trigger refuses any later change and any delete. The sales stay linked for their fiscal period. It is refused while the customer is owed store credit.
4. **Access requests.** `POST /v1/customers/:id/export` returns everything held as one JSON document: profile, consent history, purchases with lines, and store credit. It is audited and allowed for a suspended or lapsed business (`@AllowReadOnlyBusiness`), because a data subject's request does not wait for a subscription.
5. **A sale names its customer** (`sales.customer_id`, optional). This is for counter sales and exchanges (restaurant checks, withdrawn 2026-10-25, never had one). The receipt prints the customer's name, and their TIN when they gave one. Purchase history shows only the sales the reader may read (`sales.read` at the sale's scope, or their own sales).
6. **Store credit is a liability of a legal entity.** `customer_credit_entries` is append-only and kept per (customer, legal entity). A `RETURN` entry (+) is a refund given as credit (`sale_returns.refund_method = 'STORE_CREDIT'`): no cash moves and the drawer is not checked. A `REDEEM` entry (−) is credit spent through a `STORE_CREDIT` tender, which is applied after card/QR and before cash, never more than is due. An insert trigger takes a per-(customer, entity) advisory lock (the API takes the same one first), checks that the entry matches its return or its sale's store-credit tender, and refuses a balance below zero. Two tills spending the same credit: one wins, the other gets 409 `INSUFFICIENT_STORE_CREDIT`.
7. **Books.** A new system account, *2300 Customer store credit* (LIABILITY), is seeded for new entities and back-filled for existing ones (migration 0075). A return as credit credits it instead of cash; a redemption debits it instead of cash. `ledger.test.ts` checks the GL against the credit ledger. Card/QR clearing no longer counts store-credit tenders.

## Consequences
- The `customers.*` permission codes now grant something.
- Reports by tender and Z-readings show `STORE_CREDIT` as its own method (sales paid with credit, and returns refunded to it).
- Tests: `customers.test.ts` (6: profiles and audit by field name, consent, history visibility, credit return/spend/books, concurrent spending, DB guards, export, anonymising), `isolation.test.ts` (+8 routes, +3 smuggling cases, 3 tables), `ledger.test.ts`, `@1pos/accounting` (+1), `test:e2e:web:customers` (21), `test:e2e:pos:controls` (+8).

## Not covered
- Customer accounts receivable (charge to account, statements, payments, aging).
- Loyalty points (Phase 7) and offers or campaigns themselves (consent is recorded; nothing is sent).
- Expiry of unspent credit (accountant, question 11) and automatic anonymisation after the retention period (DPO).
- Customer-specific VAT treatment (zero-rated or exempt buyers): tax adviser.
- A customer on a held cart; offline: the till offers customers online only.
