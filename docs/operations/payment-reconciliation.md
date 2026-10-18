# Runbook: payment reconciliation

For: branch managers and the business's accountant (the daily and monthly checks), and Tilvara support (the
card/QR intents that need help). Design: ADR-0010 (payment intents), ADR-0009 (cash), ADR-0013 (books).

**Current state.** The only payment provider is `DevPaymentProvider`, and production refuses it. Until
the PayMongo adapter exists (D6), a production business takes **cash only**, plus card or QR on its own
separate terminal outside Tilvara. Sections 1 and 2 apply now. Section 3 applies the day PayMongo is
connected, and section 4 lists what will be added then.

## 1. Every shift: the drawer

A shift (cashier session) is the unit of cash reconciliation.

1. **Close the shift** on the POS: the cashier counts the drawer. Tilvara computes what the drawer should
   hold: opening float + cash sales − change given − cash refunds + pay-ins − pay-outs.
2. **No difference**: the shift is `RECONCILED` at once.
3. **A difference** (over or short): the variance is posted to the books at the close, as counted. The
   shift stays `CLOSED` until a manager approves the variance with a reason
   (`POST /v1/cashier-sessions/:id/approve-variance`), then becomes `RECONCILED`. **The approver must be a
   different person from the cashier** (`SELF_APPROVAL`). An approval still waiting after 2 days raises
   `OneposVarianceAwaitingApproval`.
4. A shift **cannot close** while:
   - offline sales of that shift wait for review (`OFFLINE_SALES_UNRESOLVED`);
   - a card/QR payment has no outcome, or succeeded without becoming a sale (`PAYMENTS_OUTSTANDING`,
     section 3).
   Both are deliberate: a closed shift must hold every payment it took.

The shift page in the admin (Shifts) shows the float, pay-ins and pay-outs, the count, the sales
and the variance.

## 2. Every day: tenders against the books

Per branch, for the business day:

| Check | Where | Must hold |
|---|---|---|
| Sales by tender | Reports → Sales → By tender | Cash + card/QR + other = net sales of the day |
| Cash | Shift pages of the day | Σ counted cash of the shifts = Σ expected ± approved variances |
| Card/QR | By tender report, card/QR line | = the provider's report of approved payments for the day (section 3) |
| Books | Books → Trial balance, or the journal filtered to the day | Cash on hand and Card/QR clearing (1020) moved by the same amounts as the tender report |
| Open items | Overview, Offline | No shift left open, no offline sale waiting, no payment without an outcome |

A difference found here is investigated before the next day's close. Corrections are new documents
(a return, a reversal entry), never edits ([rollback-recovery.md](rollback-recovery.md) section 4).

The daily per-branch reconciliation report that puts these checks on one page is built in slice 9
(ADR-0016). Until then, the checks above are done from the existing reports.

## 3. Card/QR payments that need attention

A card or QR payment is a **payment intent**. Tilvara records the intent first, asks the provider second,
and records the outcome third, so a lost answer can never charge twice.

| Intent state | Meaning | What to do |
|---|---|---|
| `PROCESSING` | Asked the provider, answer not back yet | Wait a moment, then **Check payment** |
| `UNKNOWN` | The provider did not answer in time (`PAYMENT_TIMEOUT_MS`). The customer may or may not have been charged | **Check payment**. **Never take the payment again before it is resolved** |
| `SUCCEEDED`, no sale yet | Charged, but the sale did not complete (the till lost the answer, the cashier backed out) | Complete the sale with it, or **Cancel payment** (the provider voids or refunds it) |
| `FAILED` | Declined, or the provider has no record of it | Nothing was charged. Take payment again if the customer wishes |
| `CANCELED` | A succeeded payment that was voided before it became part of a sale | Nothing to do |

- **Check payment** (POS, or `POST /v1/payment-intents/:id/reconcile`) asks the provider what happened and
  settles the intent. If the provider has no record, the intent becomes `FAILED`.
- **Cancel payment** (`POST /v1/payment-intents/:id/cancel`) is allowed only for a succeeded intent that
  no sale used.
- The shift close screen lists every intent that blocks the close, with both buttons.
- `OneposPaymentUnresolved` fires when any intent has waited more than 15 minutes for its outcome
  ([monitoring.md](monitoring.md#onepospaymentunresolved)).
- Every step is in `payment_events` (append-only): requested, authorized, declined, timeout, reconciled,
  canceled, consumed. Tilvara never receives card numbers or CVV.

**Customer says they were charged but there is no sale**: find the intent by time and amount on the shift
page. `SUCCEEDED` without a sale → complete the sale or cancel it. `UNKNOWN` → Check payment.
`FAILED` → the provider confirms nothing was charged; if the customer's bank still shows a hold, it is an
authorisation that the bank releases (the provider's support can confirm).

**Charged twice**: each intent is one charge (the intent id is the provider's idempotency key). Two
charges mean two intents. Find both; the one without a sale is cancelled. If both became sales, return
one sale (the refund to card waits for the PayMongo adapter; until then the business refunds in cash
and records it as a return).

## 4. After PayMongo (D6): settlement

Added with the adapter, and this section then becomes the procedure:

- **Webhooks** (`payment.paid`, `payment.failed`) settle intents through the same path as Check payment;
  signature, timestamp window and event dedupe are tested (THREAT_MODEL T6).
- **Daily**: the provider's transaction report for the day = the card/QR tender total per branch. Every
  provider transaction maps to exactly one intent (by intent id), and every succeeded, consumed intent to
  one provider transaction.
- **Payouts**: the provider pays out net of fees, days later. The payout moves the amount from Card/QR
  clearing (1020) to the bank and the fee to an expense. That posting does not exist yet; until it does,
  the accountant records payouts by manual entry, and the clearing balance must equal approved card/QR
  sales not yet paid out.
- **Refunds to card** and **chargebacks**: procedures written with the adapter (LEFTOVER).
