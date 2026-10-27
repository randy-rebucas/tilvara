# ADR-0027: Subscription billing — bills, payments and the renewal pass

- Status: Accepted (2026-10-27, session 44).
- Context: businesses had a subscription row (plan, status, trial end, paid-until, grace end) and an access rule (`app_subscription_write_allowed`), but nothing billed them. Ops changed plans by hand (`support subscription-set`, session 43), an ACTIVE subscription never expired, and the admin said "online billing is coming". The user asked to implement subscription payments in full: manual payments now, PayMongo, renewals and plan changes.
- Builds on ADR-0010 (payments port; provider calls never inside a transaction), ADR-0016 (platform functions, support CLI, monitoring) and session 43 (`platform_change_subscription`, `/me` → `access`).
- PayMongo was chosen on 2026-10-15. Its sandbox keys (D6) are still not in `.env`, so the adapter is tested against a stand-in and a signed-webhook test, not the real sandbox.

## Decision

### 1. Records (migrations 0128–0129)
- **`billing_bills`**, per business, numbered `B-000001`…: kind `START` (first period, or after a lapse), `RENEWAL` or `UPGRADE`; plan, period, amount, currency, due date; status `OPEN` → `PAID` or `VOID`, once (trigger). At most one open period bill and one open upgrade per business.
- **`billing_payments`**, append-only: amount, method, provider (`MANUAL`, `PAYMONGO`, `DEV`), the provider's or bank's reference (unique), `applied`. Money that cannot settle a bill (already paid, voided, a different amount) is kept with `applied = false`, never lost.
- **`billing_checkouts`**: a hosted payment page opened for a bill. Reused for 23 hours, so a double click opens one page.
- **`billing_provider_events`**: each accepted webhook event, once. No tenant column and no runtime access.
- `subscriptions` gains `scheduled_plan_code` (a plan costing no more, from the next renewal) and `cancel_at_period_end`.
- The business reads its bills, payments and checkouts under RLS. It writes none of them: every write is a `billing_*` definer owned by `onepos_platform`. The runtime role cannot call the internal steps (`billing_issue`, `billing_settle`, `billing_take_payment`, …) or the platform ones.
- A bill is a statement of what is owed. It is **not** a BIR invoice or official receipt (the mail and the screen say so). Tilvara's own invoicing for its fees is a question for the tax adviser.

### 2. Access rule
- `ACTIVE` now ends a week after `current_period_end`, even if the billing pass stopped running (it makes the subscription `PAST_DUE` at that date anyway). `NULL` (set by hand before billing) stays open-ended.
- The rest is unchanged: `TRIALING` until the trial end; `PAST_DUE` until the grace end (7 days); anything else is read-only, and nothing is ever deleted.

### 3. The hourly pass (`platform_billing_tick()`, run by the worker)
- A **renewal bill** a week before the paid-until date, for the scheduled plan if any. Due on the paid-until date.
- A **START bill** three days before a trial ends, once.
- At the paid-until date: **`PAST_DUE`** with 7 days of grace, or **`CANCELED`** when the owner asked to stop (open bills voided).
- Closes checkouts older than their reuse window, and upgrade bills whose period has ended.
- Mails the owners (`billing.bill_issued`, `billing.past_due`, `billing.canceled` outbox events).
- **A plan priced 0 is never billed.** The migrations ship placeholder prices of 0, so nothing is billed until ops sets real prices (`support plan-price`, audited).

### 4. Paying a bill (`billing_settle`)
- `START`/`RENEWAL`: the subscription becomes `ACTIVE` on the bill's plan until the bill's period end. If paid more than a week after the period began, the period is re-based on the day of payment, so a long lapse is not charged.
- `UPGRADE`: the new plan applies now, same period.
- A paid renewal voids an open upgrade, which was priced for the period before.
- Every change writes `billing.*` and `subscription.changed` rows in the business's audit log.

### 5. The owner (`subscription.manage`, admin Plan tab)
- **Choose a plan.**
  - During a paid period, a dearer plan is billed now for the rest of the period, prorated, and applies when that bill is paid. A plan costing no more starts at the next renewal.
  - Otherwise (trial, past due, canceled, lapsed), the period's bill is issued, or issued again, for that plan.
  - A plan smaller than what the business has is refused (`PLAN_LIMITS_EXCEEDED`).
  - So a business can never give itself a plan it has not paid for, which was the reason there was no self-service before.
- **Stop at the end of the paid period, or resume.**
- **Pay:** the API opens the provider's page between two transactions and the browser goes there. The return address only shows "being confirmed"; the signed webhook is what pays the bill.
- **Who can use these:**
  - A lapsed (read-only) business can still choose and pay, because that is how it renews (`mutate(…, { allowReadOnlyBusiness: true })`).
  - A business Tilvara suspended cannot (the guard refuses it, and the service checks again).
  - Support sessions and API keys cannot.

### 6. Providers (`BILLING_PROVIDER`)
- **`paymongo`**: Checkout Sessions API.
  - Line item in centavos, `reference_number` = bill number, metadata with ids only.
  - Methods: card, GCash, Maya, GrabPay, QR Ph.
  - The webhook `POST /v1/billing/webhooks/paymongo` keeps the raw body, checks `Paymongo-Signature` (HMAC-SHA256 of `t.body`, `te`/`li` by mode, 5-minute window, constant-time compare), then calls `billing_apply_provider_payment`.
  - The payment must belong to a checkout Tilvara opened, and settles only for the bill's exact amount and currency. An event is applied once; a payment reference is recorded once.
  - Needs `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET`.
- **`dev`** (default; refused in production):
  - A page served by the API at `API_PUBLIC_URL/v1/billing/dev-checkout?id=…` pays the bill on a click, through the same function as the webhook.
  - Pages live in the API process.
- **Ops** record money received outside the page (bank transfer, a GCash send) with `support billing-payment`, and void a bill with `support billing-void` (both audited).

### 7. The user's decisions on the open items (same session)
- **Tilvara is VAT-registered.** Prices are VAT-inclusive at 12%. Each bill keeps the VAT inside its amount: `vat_amount` = amount × 12/112, fixed at issue like the amount (migrations 0130–0131; earlier bills filled in). The VAT shows on the admin's bills, in the mails and in `support billing-bills`. A bill is still not an official receipt; how Tilvara issues those is its accountant's process.
- **Back to the shop's own address.** After the payment page, the owner returns to `<slug>.<SHOP_DOMAIN>` when the business has its own sign-in page on, else to `APP_PUBLIC_URL`. `SHOP_DOMAIN` is the API's copy of the admin's `ONEPOS_SHOP_DOMAIN`; the address rule is `shopAddress` in `@1pos/validation`, shared with the admin.
- **No partial payments.** Only a bill's exact amount settles it; anything else is kept unapplied for a refund. The screens, mails and CLI say to pay the full amount.
- **Remind them before the bills.**
  - Mail: besides the mail when a bill is issued (a week before), a `billing.reminder` goes out three days before and the day before the due date, once each (`reminded_early_at`, `reminded_last_at`), from the hourly pass. A bill issued within the last day gets no reminder yet.
  - Owners see the open bill above every page from a week before its due date (overdue in warning colour while still in grace), with a link to pay.

### 8. First prices and receipts (same session)
- **First prices**, VAT included, set by migration 0133 where a plan was still at 0:
  - Starter ₱999 a month;
  - Growth ₱2,499;
  - Enterprise ₱5,999.
  - These sit below the published Philippine cloud POS subscriptions of the same reach (UTAK from about ₱1,500; StoreHub ₱2,249 / ₱4,499 / ₱8,999, billed annually; Loyverse free with paid add-ons), as of October 2026. Ops changes them with `support plan-price`.
- **Receipts are system-generated.**
  - Every payment that settles a bill gets a `billing_receipts` row in the same transaction.
  - Numbered in one series for Tilvara as issuer (`R-00000001`…), gapless: taken under an advisory lock.
  - Holds Tilvara's details (`billing_seller`: registered name, TIN, address, VAT registration, permit line; set with `support billing-seller`) and the business's (name, first legal entity's registered name, TIN, address), both copied as they were that day.
  - Also: the description, VATable sales + VAT = total, the method and the reference. Append-only.
  - Mailed to the owners (`billing.receipt_issued`) and kept in the app: Subscription → Plan → Bills → Receipt R-…, a printable page (`GET /v1/subscription/receipts/:id`).
  - Payments settled before 0133 got their receipts in the migration, without mail.
- **The global numbering is deliberate:** a receipt series belongs to its issuer. A business sees how many receipts Tilvara has issued; that is accepted, as on any invoice.
- **Not a compliance claim.** Whether these receipts satisfy the BIR for Tilvara's own sales depends on Tilvara's registration of its system-generated receipts (the permit line shows once there is one). That is for Tilvara's accountant; nothing here claims it.

### 9. Monitoring
`onepos_billing_events_total{provider,step,outcome}` counts these events, with three alerts:
- `OneposBillingPaymentNotApplied`: money arrived that settled no bill;
- `OneposBillingWebhookRefused`: webhooks failing the signature check;
- `OneposBillingCheckoutFailing`: payment pages failing to open.

## Consequences
- **What the business sees:** the subscription screen and mails tell owners how to renew by themselves; "contact support to renew" is gone. Ops still has `subscription-set` for exceptions.
- **The webhook's trust:** the runtime role may call `billing_apply_provider_payment`, so a compromised API could forge a payment.
  - Mitigations: the signature is checked before the call; the payment must match a checkout row Tilvara opened for an open bill, at the exact amount; every event is recorded.
  - Accepted because the API already holds the webhook secret. THREAT_MODEL T6.
- **Not done:**
  - automatic charging of a saved card (the owner pays each bill on the page);
  - refunds through the provider (ops refunds in the dashboard; the payment stays `applied = false` or the bill paid);
  - billing currency other than PHP;
  - the real PayMongo sandbox run (D6 keys).
