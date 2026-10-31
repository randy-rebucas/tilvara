# Open items after the third full audit (2026-10-27, session 45)

These are the items from [the audit](AUDIT-2026-10-27.md) that were not fixed, or were fixed only in part, in session 45. Every other finding was fixed (see the audit's §5). Each item below says where it lives, what is known, and what would close it. When an item is closed, mark it ✅ here and note it in `docs/STATUS.md`.

## 1. Decisions needed

### 1.1 ⬜ Manual VAT settlement entries (#11)
- **Now:** a manual journal entry may post to the business's own accounts and only three system accounts: `CASH_ON_HAND`, `CASH_IN_BANK` and `CASH_TRANSFERS`. Anything else is refused with `SYSTEM_ACCOUNT_NOT_ALLOWED`. That list is `MANUAL_SYSTEM_ACCOUNTS` in `apps/api/src/accounting/accounting.service.ts`, mirrored in `apps/admin-web/src/lib/manual-entry.ts`.
- **The catch:** a by-hand VAT settlement, which offsets `INPUT_VAT` against `OUTPUT_VAT` and pays the net, is refused too.
- **Question for the accountant or tax adviser:** should `INPUT_VAT` and `OUTPUT_VAT` be added to the list? `ledger.test.ts` compares output VAT with the sales evidence, so a settlement entry may need its own source type rather than a MANUAL entry.

### 1.2 ⬜ A supplier return of non-stock lines without its goods receipt (#10)
- **Now:** a return of stocked lines must name its goods receipt (`GOODS_RECEIPT_REQUIRED`). A return of only non-stock lines without a receipt is still allowed. It debits GRNI, and nothing clears that debit.
- **Detection:** the new GRNI check in `apps/api/test/integration/traceability-audit.ts` flags it, and `audit45-backoffice.test.ts` pins that behaviour.
- **Related:** a return that names its receipt but not the receipt line skips the "not yet returned" check and is credited at average cost (`receiving.service.ts` `returnLots`). `purchasing.test.ts` allows that on purpose.
- **Options:** require a receipt, and a receipt line, for every return line, or keep the current rule.

### 1.3 ⬜ API key scope for discount schemes (#21)
`GET /v1/discount-schemes` now needs `catalog.read` for an API key, because the till prices with these schemes. `org.read` would be the alternative. Confirm, or change the `@ApiKeyRequires` in `apps/api/src/tax/tax.controller.ts`.

## 2. Work left (its own slice)

### 2.1 ⬜ Verify the email at sign-up (#25)
- **Now:** sign-up never verifies the address. Someone can sign up with another person's email and enrol two-step sign-in, locking the real owner out until support runs `mfa-reset`.
- **Work:**
  - a `users.email_verified_at` column;
  - a mail link (the same mechanism as `/confirm-email`);
  - two-step enrolment, and invitations to an unverified account, refused until the email is verified;
  - factors cleared on the first password reset of a never-verified account;
  - an integration test and E2E.
- **Where:** `apps/api/src/auth/auth.service.ts` (sign-up), the `auth_*` definer functions, the admin sign-up and security screens.

### 2.2 ⬜ Re-price offline sales from the snapshot's own facts (#12, option b)
- **Done (option a):** tax profiles created after the snapshot are ignored.
- **Still read as they are now:** the item's tax category, its VAT treatment, the whole-unit flag, and the branch's price list with its "prices include tax" setting. Change one of these while sales wait offline, and those sales are quarantined with `TOTAL_MISMATCH`, so only dismissing them is left.
- **Work:** keep, per snapshot, what the till priced from: per-item price id, VAT treatment and unit flags, plus the price list (or a hash of them) on `terminal_snapshots`. Then re-price from that in `SalesService.recordOffline`, `TaxService.computeCart` and `PricingService`.

### 2.3 ⬜ Mail sent twice on a retry (#48)
A mail to several owners (billing, stock alerts) re-sends to the first owners when a later send fails and the outbox retries (`apps/workers/src/handlers.ts`). It matters once a real mailer exists (D2). **Fix then:** one outbox row per recipient, or a per-recipient sent marker.

### 2.4 ⬜ A sale delivered after its count sheet was posted (#7 residue)
- **Now:** count sheets post against the stock on record when each line was counted (ADR-0012 amendment 3, migrations 0134–0135).
- **One case is left:** a sale rung before an item was counted, but delivered only after the sheet was posted, is still deducted twice. The count already saw the shelf without it, and the late SALE movement takes it off again.
- **Possible fix:** when an offline sale arrives with `completed_at` before a posted sheet's `counted_at` for that item, post the compensating COUNT movement. That is a costing-trigger change needing an ADR note.

## 3. Not yet seen working (verification gaps)

### 3.1 ⬜ PayMongo against its sandbox (#3, #16)
- **What changed:** the worker now expires a cancelled bill's checkout session (`apps/workers/src/billing-checkouts.ts`, `POST /v1/checkout_sessions/{id}/expire`). Webhooks must match the key's live or test mode.
- **What was tested:** only with the Dev provider and unit tests of the HTTP mapping.
- **To close:**
  - a PayMongo test account and a run of `pnpm test:e2e:web:billing` with `BILLING_PROVIDER=paymongo`;
  - a check that PayMongo answers the expire call as assumed (400/404/409/422 when the session is already done);
  - a check of how long sessions really last.
- This joins the existing LEFTOVER item on real PayMongo payloads.

### 3.2 ⬜ E2E suites after the session 45 changes
- **Rewritten:** seven admin E2E scripts now read through the API directly, because the proxy no longer forwards GETs (#44): `backoffice`, `branding`, `extensions`, `onboarding`, `review`, `shop-address` and `smoke`. `shop-address` also clicks the new "Continue to …" hand-off button (#23).
- **Changed outcomes:** `stock.mjs` expects different count-sheet numbers (#7). `packs.mjs` may open packs by hand that are not on hand, which is now refused with `PACKS_NOT_ON_HAND` (#35).
- **Status:** only `node --check` was run on these. See STATUS session 45 for which suites were run.
- **To close:** run them all against a current build, API and `next start`.

### 3.3 ⬜ Behaviour changes to watch
- **Hourly worker steps (#5):** these are purge, expiring lots, the billing pass and data-export expiry. They are now marked done for the hour before they run. If the database is down, they wait an hour instead of retrying on every poll; the failure is counted and `OneposWorkerHourlyPassFailing` fires. Decide whether that delay is acceptable.
- **Expiry mails (#30):** at an ALLOW branch, an offline sale of plainly expired stock, not only held lots, now emails `stock.expired_sold` too, matching the review flag. `app_lot_held` is not executable by the app, so held lots cannot be told apart in that path.
- **Held-cart resume (#32):** resume accepts an Idempotency-Key but does not require one, so an older till build still resumes. Make it required once every till runs the new build.

## 4. Info only (no action proposed)
- `support_list_grants`, `support_open_grant`, `auth_mfa_get` and `auth_record_login_result` do not call `app_assert_acting_user`. They are already guarded by session and MFA checks, so this would be defence in depth only.
- Seven GET routes have no admin screen: `/discount-schemes`, `/stock/movements`, price history, variant suppliers, `/z-readings/{id}`, `/reports/cashier-sessions/{id}` and `/payment-intents/{id}`. They are tested, and they are API-key surface.
- Re-pairing a till to a new terminal of the same register while the old terminal is still live quarantines its waiting sales as `UNKNOWN_SNAPSHOT`. The other session (1pos-b5) found this and logged it in `docs/LEFTOVER.md` "Second tenant audit" for a decision.
