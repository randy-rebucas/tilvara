# ADR-0010: Non-cash payments through payment intents

- Status: Accepted (2026-10-16). Provider: PayMongo (user decision 2026-10-15). Only the deterministic `DevPaymentProvider` exists until sandbox keys are provided; production boot refuses it.

## Context
SPEC §checkout: never call a payment provider inside a database transaction or while holding long locks; a provider call cannot be atomic with a commit; on timeout, reconcile the existing intent instead of charging again.

## Decision
1. **Intent first, call second, record third.** `POST /v1/payment-intents` commits a `PROCESSING` intent (with an `AUTHORIZE_REQUESTED` event), *then* calls the provider outside any transaction with a timeout, then records `SUCCEEDED`, `FAILED` or `UNKNOWN` (timeout) in a second transaction. The intent id is the provider idempotency key, so a provider retry can never create a second charge.
2. **Request idempotency is the intent itself.** The required `Idempotency-Key` is stored on the intent (unique per tenant). A retry returns the existing intent in its *current* state and never re-authorizes; the same key with a different amount/method/session is refused (422).
3. **Reconcile, don't retry.** `POST /v1/payment-intents/:id/reconcile` asks the provider what happened to an `UNKNOWN` (or stale `PROCESSING`) intent and settles it. Transitions are guarded (`UPDATE … WHERE status IN (…)`) and enforced by a trigger: PROCESSING → SUCCEEDED | FAILED | UNKNOWN; UNKNOWN → SUCCEEDED | FAILED; SUCCEEDED → CANCELED (only if unconsumed).
4. **Consumption by the sale.** A sale tender `{ method: 'INTENT', paymentIntentId }` is accepted only for a SUCCEEDED, unconsumed intent of the same cashier session and client transaction; the sale transaction locks it and stamps `sale_id` once (also unique on `sale_tenders.payment_intent_id`). Electronic tenders never produce change; cash covers the remainder and gives change. A sale that fails after a successful authorization leaves the intent SUCCEEDED and unconsumed — the cashier retries the sale or cancels the intent (provider void/refund outside a transaction).
5. **Evidence**: `payment_events` is append-only (requested, authorized, declined, timeout, reconciled, canceled, consumed) with sanitized provider details — never card data (no PAN/CVV is ever sent to Tilvara; the provider's own UI/terminal collects it).
6. **No orphan charges at close** (added at the Phase 2 exit review). `POST /v1/cashier-sessions/:id/close` is refused with `409 PAYMENTS_OUTSTANDING` (details list the intents) while any intent of the session is `PROCESSING`, `UNKNOWN` or `SUCCEEDED` without a sale. The close holds the session row lock and new intents need that `OPEN` session under the same lock, so none can appear after the check. The POS close screen lists them with *Check payment* / *Cancel payment*; a counter whose request got no answer retries with the same Idempotency-Key, or re-reads the session's intents before taking a different payment.

## DevPaymentProvider (tests and local use only)
Deterministic by the centavo part of the amount: `.51` → declined; `.52` → the provider accepts but the response is lost (timeout; reconcile finds SUCCEEDED); `.53` → timeout and the provider never received it (reconcile finds nothing → FAILED); anything else → approved. It counts charges per intent so tests can prove no double charge.

## Consequences
- The PayMongo adapter implements the same port once keys exist; its webhook (payment.paid / payment.failed) will call the same settle path as reconcile.
