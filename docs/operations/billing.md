# Subscription billing (ADR-0027)

For: Tilvara ops and whoever is on call. How businesses are billed for their plan, and what to do when a
payment needs a hand. Commands run from the repo root with ops credentials (`DATABASE_MIGRATOR_URL`), after
`pnpm build`:

```
pnpm --filter @1pos/database support <command> …
```

## 1. How it runs by itself
- **The worker's hourly pass** (`platform_billing_tick()`):
  - issues a renewal bill a week before a business's paid-until date;
  - issues a first bill three days before a trial ends (a trial that lapsed more than a week ago gets none: its
    owner chooses a plan when they come back);
  - at the paid-until date, makes the subscription past due with a week of grace, or ends it if the owner asked to stop;
  - mails the owners about each of these.
  - It runs once at a time (a second worker skips it) and each business on its own savepoint: a business it
    cannot process is skipped, logged as a database `WARNING`, counted (`onepos_worker_hourly_errors_total{step="billing_business"}`)
    and tried again next hour. Alert: `OneposWorkerHourlyPassFailing` (monitoring.md).
- **Billing periods** end on the first period's day of the month in Philippine time (`subscriptions.billing_anchor_at`):
  Jan 31 → Feb 28 → Mar 31. A late payment (more than a week after the period began) starts a new month from that day.
- **A cheaper plan chosen for the next renewal** is checked again when the renewal bill is issued: if the business
  has grown past that plan's limits since, the renewal is on its current plan, the move is dropped and the owners
  get a mail (`billing.downgrade_dropped`).
- **Upgrades** are billed for the rest of the running period plus, when the next period was already paid, that whole
  period (the difference in price).
- **Payment pages close with their bill:** when a bill is cancelled (another plan chosen, ops void) or paid, its
  other open pages are marked expired and the worker expires them at PayMongo (`billing.checkout_expired`), so an
  owner cannot pay a bill that no longer stands. Choosing the same upgrade twice keeps the bill and page already open.
- **The owner pays** in the back office: Subscription → Plan → Pay. The payment provider's page takes card,
  GCash, Maya, GrabPay or QR Ph. The provider's webhook pays the bill.
- **Plans priced 0 are never billed.** Migration 0133 sets the first prices (999 / 2,499 / 5,999); change them with
  `support plan-price` (§2a).
- **What owners can do without help:** choose a plan, upgrade (billed for the rest of the period), move to a
  cheaper plan (from the next renewal), stop at the end of the paid period, and renew after a lapse.
- **What a business keeps when it lapses:** its records stay readable and it can export them; nothing is deleted.
- **Reminders before the due date:**
  - Mail: a bill is mailed when issued, then reminded three days before and the day before it is due (hourly pass, once each).
  - Screen: owners see it above every page from a week before.
- **Prices and payment:**
  - Prices include 12% VAT (Tilvara is VAT-registered); each bill shows the VAT inside it.
  - Only the full amount settles a bill: there are no partial payments.
- **After paying,** the owner returns to the shop's own address (`<slug>.<SHOP_DOMAIN>`) when its own sign-in page is on, else to the main admin.

## 2. Receipts and Tilvara's details on them
- Every payment that settles a bill (payment page or `billing-payment`) gets a system-generated receipt, `R-00000001`…, in one series for Tilvara.
- It is mailed to the owners and kept in the app (Subscription → Plan → Bills → Receipt R-…, printable / PDF).
- Money that settled nothing gets no receipt.
- Before going live, set Tilvara's registration as receipts must show it:
  ```
  support billing-seller --name "Tilvara Technologies Inc." --tin 123-456-789-00000 --address "<registered address>" \
    --trade-name Tilvara --permit "<BIR permit / acknowledgment line, once issued>" --reason "Registration details"
  ```
  `support billing-seller` alone prints what receipts show now. Receipts already issued keep the details they were issued with.

## 2a. Setting the prices
The first prices (migration 0133, VAT included) are Starter ₱999, Growth ₱2,499 and Enterprise ₱5,999 a month.
```
support plan-price --plan growth --amount 1499.00 --reason "Price list 2026-11, approved by <name>"
```
- The price is per month, in PHP, 12% VAT included.
- Bills already issued keep their amount.
- The change is written as a platform audit row (`plan.price_changed`).

## 3. A business paid by bank transfer or a direct GCash send
1. Find the bill:
   ```
   support billing-bills --slug <business address>
   ```
2. Check the money is really in the account: the bank or wallet statement shows the reference.
3. Record it:
   ```
   support billing-payment --slug <address> --bill B-000003 --amount 1499.00 --method BANK_TRANSFER \
     --reference "BDO 0123456" --received 2026-11-02 --reason "Seen on the BDO statement" --ticket SUP-123
   ```
4. What the command says back:
   - **Applied:** the exact amount of an open bill. The bill is paid, and the subscription is active until the bill's period end. If paid more than a week after the period began, the period starts on the payment day instead.
   - **Not applied:** any other amount, or a bill already paid or voided. The money is kept as unapplied (§4).
   - **Already recorded:** the same reference again. Nothing changed.

## 4. Money that settled no bill
**Seen as:** alert `OneposBillingPaymentNotApplied`, `UNAPPLIED …` in `billing-bills`, or the owner's Plan tab saying "received that did not settle this bill".
- **Paid twice** (page and bank, or two pages): refund the second payment.
  - In PayMongo: Dashboard → Payments → the payment → Refund.
  - By bank: send it back.
  - Note the refund in the support ticket. The unapplied row stays as history.
- **Wrong amount:** ask the owner.
  - To keep the money: void the bill (§5) and record the payment against a new bill of that amount. Ops cannot issue an arbitrary bill, so if no bill fits, refund instead.
  - Otherwise refund it.
- **`unknown_checkout`** (a webhook for a page Tilvara did not open, e.g. another environment's PayMongo account sharing the webhook): check which environment the payment belongs to. Nothing was recorded in this one.

## 5. Voiding a bill
```
support billing-void --slug <address> --bill B-000003 --reason "Waived for the pilot" --ticket SUP-124
```
- Only an open bill can be voided.
- The owner sees "voided by Tilvara support".
- The next renewal bill is issued by the hourly pass as usual. To waive a period entirely, void the bill and set the paid-until date by hand with `subscription-set --status ACTIVE --paid-until …`.

## 6. Switching PayMongo on (D6)
1. In the PayMongo dashboard:
   - take the secret key (`sk_test_…` first, `sk_live_…` only in production);
   - create a webhook to `https://<api host>/v1/billing/webhooks/paymongo` for the event `checkout_session.payment.paid`;
   - copy its signing secret (`whsk_…`).
2. Set `BILLING_PROVIDER=paymongo`, `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` in the API's secret manager. The API refuses to start with `paymongo` without both, and production refuses `dev`.
   Set `BILLING_PROVIDER=paymongo` and `PAYMONGO_SECRET_KEY` for the **worker** too: it expires the payment pages of
   cancelled and paid bills (`POST /checkout_sessions/{id}/expire`); it refuses `paymongo` without the key, and `dev`
   in production. A failed call is retried by the outbox; a page PayMongo already closed counts as done.
3. Set the return addresses:
   - `APP_PUBLIC_URL` must be the admin's public address.
   - `SHOP_DOMAIN` must equal the admin's `ONEPOS_SHOP_DOMAIN`.
   - The provider sends the owner back to `<shop address or APP_PUBLIC_URL>/subscription?paid=<bill>`.
4. **Test:** on a scratch business, choose a plan, pay with a PayMongo test card or test GCash, and check:
   - `billing-bills` shows the bill paid;
   - the counter `onepos_billing_events_total{outcome="applied"}` went up.
5. **Rotating the webhook secret:** create the new secret in the dashboard, update `PAYMONGO_WEBHOOK_SECRET`, restart. PayMongo retries the events refused meanwhile.

## 7. Questions owners ask
- **"I paid but it still says unpaid":** the page confirms within a minute. If it still says unpaid after that:
  - look at `billing-bills`;
  - check the webhook's delivery log in the PayMongo dashboard;
  - check alert `OneposBillingWebhookRefused`.
- **"I want an official receipt":** bills are not official receipts. Tilvara's own invoicing for its fees follows its accountant's process (outside this system for now).
- **"I want to leave":** Plan → "Stop at the end of the paid period". Records stay readable and exportable. `tenant-offboarding.md` covers closing the business.
