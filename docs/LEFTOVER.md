# Tilvara — Leftovers (open items from finished slices and phases)

Moved out of `docs/BACKLOG.md` on 2026-10-17. BACKLOG keeps the plan (phases, slices, exits); this file keeps what each finished slice left open. Legend: ⬜ open · ⏳ waiting on a user decision (D1–D6) or an outside reviewer. Remove an item when it is done, or move it back into a BACKLOG slice when it is scheduled.

## Brand: renamed 1POS → Tilvara (2026-10-18)
Every name people see was renamed: copy (EN and FIL), titles, emails, receipts, the TOTP issuer, the OpenAPI title, the Tauri product name, CSV filenames, and the docs. These were kept on purpose:
- Kept forever, because renaming them breaks data already out there: the JWT `iss`/`aud` (`1pos-api`/`1pos`, would sign everyone out), the recovery-code and MFA-key derivation salts (`1pos-recovery:`, `1pos-mfa`, would invalidate codes and secrets), the till keychain service `"1POS till"` and the Tauri identifier `ph.onepos.till` (tills would lose their saved credential and local SQLite data).
- Renameable later, as a separate slice: the `@1pos/*` package scope, the `onepos_*` DB roles and DB names (these appear in migrations that are already applied, so this needs new migrations plus `01-roles.sql` and a dev-volume upgrade script), the `x-onepos-request` CSRF header, the `Onepos*` alert names, the compose project, the cargo crate and exe name `onepos-till`, and the localStorage keys.
- ⏳ Trademark and domain clearance for "Tilvara" (WIPO, IPOPHL classes 9/42, `.com`/`.ph`) before any public launch; `api.1pos.ph` in `desktop.test.ts` is only an example host.

## Audit 2026-10-19 (session 19) — gaps no earlier list had
Full write-up and evidence: [AUDIT-2026-10-19.md](AUDIT-2026-10-19.md). Fixed in the session: payables screens, journal labels, stock adjustment/waste form, entity/branch/register details, till pay in/out, returns of earlier sales, KDS sold out, payables list filter and aging day, invoice-entry reversal guard, search errors at the till, two test-suite defects.
Session 20 built customers (ADR-0018), the till controls (held carts, exchanges, discounts, manager price override, returns of another register's sale; ADR-0017), stock reservations and supplier catalog references, the analysis reports (category, branch/consolidated, discounts and overrides, purchases by supplier, payment exceptions), and API keys and webhooks (ADR-0019). `customers.*`, `sales.price_override` and `integrations.manage` now grant what they say. Session 21 settled the three decisions. Session 22 closed the remaining work items: webhook DNS pinning, API-key expiry in the admin, business rename, Senior Cashier and Purchasing Officer roles, roles/sample items/screens following the type and plan, editing pending order items and per-item comps at the till, supplier credit/debit notes, payments over several invoices and payment voids.
- ⏳ **Mobile app** (SPEC §5.3): no app and no plan; the user chose to leave it as is (session 20). Scope and timing are the user's call.
- ⏳ Cashiers hold `customers.read` but not `customers.manage`, so a cashier cannot add a new customer at the till (a branch manager can). Whether the cashier template gets it is the user's call (ADR-0018).
- ⏳ Store credit posts to `CUSTOMER_STORE_CREDIT` (2300, liability); accountant question 11 asks them to confirm the account and its treatment on the books and the receipt. Customer accounts receivable (sales on account, statements, customer payments) is not built.
- ⏳ Customer-specific VAT treatment (zero-rated/exempt buyers) — tax adviser.
- ⬜ Held carts are never discarded automatically: a cart parked and forgotten keeps its lines (and any SC/PWD name and ID) until someone resumes or discards it. Proposed: discard after 7 days (processing register, retention row "Held carts"; DPO to confirm the period).
- ⬜ Customers are never anonymised automatically (proposed 2 years after the last purchase; waits on the DPO like the other purge jobs).
- ⏳ `webhook_deliveries` is never purged (proposed 30 days after delivered/dead; retention schedule) — waits on the DPO's periods like the other purge jobs.
- ✅ Restaurant: a pending item's choices change in place (session 25, `PATCH /v1/order-items/:id { modifierOptionIds }`). ⬜ Comps use `sales.discount`; a separate comp permission or a comp reason report is not built (reasons are in the `order.billed` audit row).
- ⬜ Shift close with open bills (session 21): the admin has no shift-close screen, so the manager override exists only at the till. (`test:e2e:pos` 41/41 and `test:e2e:service` 22/22 re-run in session 22 against the refusal.)
- ⬜ Plan prices are still placeholders (`0.0000`); the plan contents were decided in session 21 (Starter: none; Growth: restaurant, multi_entity, advanced_reports; Enterprise: all four).
- ⬜ Watch: `offline-sync.test.ts` failed once with `TAX_PROFILE_MISSING` in a full gate run (session 20) and passed on its own. The likely cause is the Docker VM clock running ~1 s off the host around a profile's effective time. Two billing tests failed the same way and their tolerance was widened. If it recurs, give the fixture's tax profile an earlier effective time.
- ⬜ Offline sales after a lapse (session 21): a till that stays offline keeps selling on its last writable snapshot for up to `OFFLINE_WINDOW_HOURS` after a lapse or suspension, and those sales are recorded (audited `offline_sale.recorded_while_read_only`); that bound is the posture accepted. Snapshots issued before migration 0080 count as not writable.
- ⬜ CI scope once it runs: no E2E suites, restore drill or `cargo test` in `ci.yml`.
- ⬜ Weighing-scale and barcode-scanner adapters (§5.2; manual weight, scale labels and keyboard-wedge work today).

## Audit 2026-10-21 (session 31)
Full write-up: [AUDIT-2026-10-21.md](AUDIT-2026-10-21.md). Every defect (§2) and every work item (§3) was fixed in session 31, and decisions A1–A6 were taken as recommended (§4, the user asked to fix them all). Migrations 0107–0109.
- ⬜ E2E suites not re-run after the audit fixes: `web:onboarding`, `web:account`, `pos:mfa`, `test:e2e:desktop` (the other 33 pass; audit §7). New category, units and trip-edit screens are covered by `backoffice.mjs` and `restaurant.mjs`. There are no E2E steps yet for VOID kitchen slips (printed by the desktop till), the check customer picker, overstays, or staff archive conflicts; integration tests cover them.
- ⏳ DPO to confirm A1 (service notes refused to API keys and support sessions, appointment notes blanked for them) and the processing-register wording.
- ⏳ A3 means branch managers of LAUNDRY and HYBRID businesses (HYBRID is the sign-up default) now need two-step sign-in after the grace period, because they hold `laundry.dispose`. Tell pilot businesses; or decide to take `laundry.dispose` out of the branch-manager template outside LAUNDRY.
- ⏳ A5: a return of a sale paid partly with store credit gives credit back in proportion to what credit paid, not credit first. The accountant to confirm (add to their questions with store credit).
- ⬜ Watch: `rate-limit.test.ts` "two replicas share one signup allowance" failed once in a full gate run (400 for 429) and passed alone; and `monitoring.test.ts` "business gauges equal independent counts" can race other suites' outbox events.
- ⬜ The night audit still runs in the API process with a cross-tenant scan granted to `onepos_app` (A6, documented in ADR-0023). Move it into the worker if another scheduled posting needs the tax and ledger code there.

## Session 30 — pharmacies and drugstores (ADR-0025)
- ⏳ Pharmacist-in-charge and DPO: the prescription book and dangerous drugs register formats and retention, partial fills of yellow prescriptions, whether a pharmacy assistant may hand over Rx medicines under supervision (the till asks for the pharmacist's approval), retention of prescriptions (health data; privacy §15d, retention schedule). Compliance assumptions §10A, question 17.
- ⏳ Tax adviser: the current SC/PWD purchase booklet rule for medicines (Tilvara requires it by default, `pharmacy_settings`), quantity limits if any, and the current VAT-exempt medicine lists (the business marks those items VAT-exempt by hand).
- ⬜ Maximum drug retail prices (MDRP/EO 104): no price ceiling check. e-Prescriptions, FDA/DDB online reporting, compounding and repacking records: not built.
- ⬜ Photos or scans of prescriptions (needs file storage, D1). Refill reminders to customers.
- ⬜ Offline refills: the snapshot carries no patient data, so an offline till records only new prescriptions; a customer's earlier prescription is filled online only.
- ⬜ Choosing the lot at the till; cost per lot. The expiry date is taken as entered (a month-only date is not read as its last day).
- ⬜ A worker integration test for the `stock.expired_sold` mail (the mail builder `expiredSoldMail` is untested; the event itself is checked in `pharmacy.test.ts`). Offline pharmacy sales in a browser E2E (covered by pos-offline unit tests only).
- ⬜ The till does not show a pack's chain ("1 box = 10 strips = 100 tablets"); the lookup does not return it. Thermal receipts put the generic and lots on one wrapped detail line, so a lot code can break across lines (`@1pos/escpos` has no separate small line).
- ⬜ The dangerous drugs register counts stock brought in by a stock adjustment under "Adjusted", not "Received" (only goods receipts, transfers in and pack openings count as received).
- ⬜ Online name search for medicines matches one word or the exact phrase (`/v1/products?q=` is a plain ILIKE); the offline engine matches several words in any order.
- ⬜ Filipino copy for the pharmacy screens needs a native speaker's review.

## Session 29 — laundromats and laundry shops (ADR-0024)
- ⏳ **D7 — SMS provider and account** (e.g. Semaphore): only `DevSmsSender` exists; the worker refuses the dev SMS driver in production. Notices in Filipino by customer preference and two-way SMS wait on it.
- ⏳ Accountant: down payments held on *2330 Customer down payments* without VAT until the claim sale; forfeits (cancel, disposal) on *4120 Forfeited down payments* with VAT. Add to the review request with store credit, tips, packages and lodging deposits.
- ⏳ The business's adviser: the claim policy text and the rules on abandoned goods (disposal after `unclaimed_days`) are unverified; the default text is a starting point only.
- ⏳ DPO: walk-in names and phones on job orders, trip addresses and phones, masked notice recipients (processing register §15c, retention schedule); no purge job yet, like the others.
- ⬜ Partial claims (some bags now) and splitting a job; customer accounts receivable for business clients (monthly billing).
- ⬜ Supplies used on cancelled or disposed jobs post no consumption (recipes run only with the claim sale); per-kilo packages (packages take whole LOAD/PIECE units only).
- ⬜ Down payments do not take store credit (as lodging deposits). Machine utilisation is over 24-hour days (branches have no opening hours). The trial samples' detergent sachets are untracked and have no recipe (samples never touch stock).
- ⬜ Driving coin/card machine controllers; a customer-facing status page.
- ⬜ Filipino copy for the laundry screens needs a native speaker's review.

## Session 28 — hotels, resorts and transient houses (ADR-0023)
- ⏳ Accountant: VAT timing of nightly room charges vs. the invoice issued at check-out; deposits held without VAT until applied; forfeited deposits as cancellation fees with VAT. Add to the review request with store credit, tips and packages.
- ⏳ Tax adviser: the local accommodation tax (rate and base per LGU; base used = the night's amount due less VAT, after SC/PWD; adjustments carry none), off by default and marked unverified. SC/PWD on room nights follows the pending SC/PWD review; several schemes on one stay split the night into lines (centavo rounding).
- ⏳ DPO: guest registry (`stay_guests`: nationality, ID type/number, address, birth date, contact) in the processing register and retention schedule; no purge job yet, like the others.
- ⬜ Group bookings and a master folio, splitting a folio, moving charges between folios; refunding a folio credit balance; a tip charged to the room.
- ⬜ Writes from an outside PMS (needs write-scoped API keys: a decision), channel managers (Booking.com, Agoda), a public booking page, online deposits; room service as an order type; rate plans (seasons, weekends); per-person environmental fees.
- ⬜ Till: booking a future stay, cancel and no-show, card/QR deposits, bank-transfer refunds, folio adjustments and night reversals, printing the registration card (all in the admin today). Admin: no one-step walk-in (book, then check in) and no full stays list page.
- ⬜ Reversing a night after a credit adjustment can be refused (`FOLIO_OVERPAID`) because the night's accommodation-tax reversal is a separate entry; reverse first, then adjust.
- ⬜ Check-out refuses while a deposit exceeds the balance (`DEPOSIT_HELD`): refund the rest first. Deposits do not take store credit; card refunds of deposits are not supported.
- ⬜ Tests not written: the night audit skipping a read-only business and catching up once it is writable; Charge to room on restaurant checks in E2E; the hidden tender and Rooms callout offline (browser mode cannot go offline); workers E2E for the three new webhook topics.
- ⬜ Filipino copy for the lodging screens (admin ~325 keys, till ~143) needs a native speaker's review.
- ⬜ `backup.test.ts` and the desktop till (`cargo test`, `test:e2e:desktop`) were not re-run in session 28 (no Rust changed; the offline engine is unchanged).

## Session 27 — beauty salons, spas and barber shops (ADR-0022)
- ⏳ Accountant: packages are owed until used (*2310 Prepaid service packages*, ex VAT; VAT due when paid); unused sessions of an expired package stay owed (breakage not recognised); commissions are a report only. Add to the accountant review request with store credit and tips.
- ⏳ DPO: service notes may hold allergies (sensitive personal information); retention periods proposed for appointments, notes and staff records (processing register §15a, retention schedule). No purge jobs yet, like the others.
- ⬜ Refunding part of a used package (only whole unused packages come back), moving a package to another customer, and package sessions on restaurant checks; keep PACKAGE items off restaurant menus (a menu does not refuse them today; a check records such a line as an ordinary sale).
- ⬜ Public booking page, deposits, SMS reminders (needs a provider), reminders in Filipino; rooms or chairs as booked resources.
- ⬜ Paying out commissions and tips per staff member (the drawer pays tips out as one amount); payroll.
- ⬜ Appointments and package sessions need the server (the offline till sells services and names staff, but refuses packages and has no calendar).
- ⬜ A sale made only of package sessions sends one CASH tender of ₱0.00 (the tender list needs one entry); the API could accept no tenders when nothing is due.
- ⬜ Time off older than 30 days is not shown on the staff page (kept in the table).
- ⬜ Filipino copy for the salon screens (admin and till, ~150 keys) needs a native speaker's review.
- ⬜ `backup.test.ts` and the desktop till (`cargo test`, `test:e2e:desktop`) were not re-run in session 27 (no Rust changed; the offline engine gained staff on lines and refuses packages).

## Session 26 — retail stores and boutiques (ADR-0021)
- ⏳ Tax adviser: SC/PWD always wins over a promotion on the same line (no double discount, RA 9994 IRR). Whether the beneficiary may instead choose the promotion when it is larger is for the adviser; today the statutory discount applies.
- ⬜ Promotions by category, cart-level offers ("₱100 off ₱1,000"), coupons and loyalty, a set that cheapens a different set ("buy a shirt, socks half price"), and promotions on restaurant checks.
- ⬜ One promotion per line: a line with 5 units where 3 make a multi-buy is wholly claimed by it, so the other 2 cannot join another promotion. Splitting lines per promotion would lift this.
- ⬜ A till older than this server ignores the snapshot's promotions and rings promoted items at full price; the server then refuses the total (`TOTAL_MISMATCH` → quarantined for a manager, not lost). Tills must update with the server.
- ⬜ A partial return of a promoted line refunds its share pro rata (as for any line discount); a partial return that breaks the group does not claw back the promotion.
- ⬜ Shelf locations are labels only; quantities stay per branch. Bin-level stock (quantities per shelf, moves between shelves) is not built.
- ⬜ Labels print through the browser's dialog and were checked on screen only (scale and margins on a real printer and label stock are untested). A label printer driven by the till (ZPL/ESC-POS), and the price from a scheduled price change, are not built.
- ⬜ Serial numbers, consignment, and layaway with deposits (only stock reservations exist).
- ⬜ The admin band is full (twelve tabs fit at 1440 px): Promotions, Quick keys and Labels are tabs inside Prices and Products.
- ⬜ `backup.test.ts` was not re-run in session 26 (the Docker CLI on this machine stopped answering); re-run it when Docker is back.

## Session 25 — restaurants, cafés and food trucks (ADR-0014 amendment)
- ⏳ Accountant (the user chose the defaults to build on, session 25): tips are owed to staff (`TIPS_PAYABLE`, not revenue, no VAT) and paid out from drawers; still to confirm, plus whether card tips need a settlement report against the card provider.
- ✅ A void gives a card tip back by cancelling its charge (`sale_tip_refunds`, after the void commits), cash when the provider refuses; pending ones are retried from the till (This shift → the sale → "Give the tip back") or `POST /v1/sale-returns/:id/tip-refund`. ⬜ The void slip does not print the card tip given back (the till's message and the admin's sale page show it). ⬜ Nothing retries a pending one on its own; the admin shows it but cannot retry (the till does).
- ✅ Offline tills take cash tips (envelope `tip`). Card tips stay online only.
- ✅ An offline counter sale keeps its till's call number (`restaurant_orders.till_call_number`) on the KDS, receipts, kitchen tickets and the admin.
- ⬜ Sold-out at an offline till: since the audit of 2026-10-21, marking an item sold out bumps the catalog version, so a till that is online refetches and refuses it (`SOLD_OUT`). A till that stays offline still sells what was available at its last snapshot, and the kitchen finds out from the printed ticket.
- ⬜ Kitchen printing needs a desktop till that is online and set up for the station; browser-mode screens print nothing to the kitchen. A till that crashes after printing but before marking it printed prints the ticket again a minute later (at-least-once).
- ✅ Held carts keep counter choices and kitchen notes (the server always stored them; the till now restores their names from the menu served at resume; a choice no longer offered is dropped).
- ⬜ Exchanges at a counter-service branch accept choices like a sale, untested end to end.
- ✅ A tip's charge is told from the sale's by `payment_intents.purpose` (TIP | SALE; checkout refuses a tip charge as a tender, `TIP_PAYMENT_AS_TENDER`, and a sale charge as the tip); a lost answer is recovered as the tip's.
- ⬜ Desktop till kitchen printing is tested in API integration only (claims, leases, reprints); the Tauri print loop and the printer set-up screen have no desktop E2E and no physical printer was used. `test:e2e:desktop` was not re-run.

## Session 24 — sari-sari stores: packs and pieces, expiry dates (ADR-0020)
- ⏳ Opening packs posts a revaluation of pieces sold short (and rounding) to COGS, like receipts and transfers. Accountant to confirm with the next batch of questions (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`).
- ⬜ A sale opens one level only: a pack for its pieces, never a case to get a pack. Manual openings work at any level.
- ⬜ A purchase-order line is received with one expiry date per receipt (the receipt takes each order line once). Two dates in one delivery of an ordered item need two receipts; items off the order can be repeated on one receipt.
- ⬜ No dates on count sheets or supplier returns: a count surplus is undated, and a supplier return draws by the rule (undated first, then first-expiry-first). A damaged customer return goes back to its sale's lot, but its WASTE then draws undated stock first.
- ⬜ The till shows nothing of either feature: no "Open a pack" at the counter, no warning when expired stock is sold, and the counter guide has no tingi line (sales open packs on the server, so the till needs none of this to work).
- ⬜ Grocery sample items are untracked like every sample set, so a trial shows neither packs nor expiry until the owner adds real stock-counted items.
- ⬜ Turning off "Keeps expiry dates" keeps the item's lots; they are drawn as stock goes out but no new dates come in.

## Session 23 — till quantities and stock movements
- ⏳ Damaged returns now move their cost from COGS to Spoilage and waste (RETURN then WASTE). Accountant to confirm this treatment (add to `docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md` with the next batch of questions).
- ⬜ Price approvals made before migration 0084 have no quantity (no limit); they expire within minutes, so nothing is left to do once the pilot starts on 0084. A till build older than session 23 cannot ask for a price (the API now requires `quantity`).
- ⬜ Counter "+"/"−" and rescans have no E2E check (restaurant steppers do, in `tables`/`service`).

## Phase 0 — Repository & architecture
- ⏳ CI: `.github/workflows/ci.yml` is written (session 16) and main is pushed to `origin` (github.com/randy-rebucas/tilvara, public). Pre-flight checked locally on 2026-10-19 (lockfile, LF line endings, compose container name for the backup test, `onepos_test` from the init script, `.env.example` = dev `.env`, `security:audit` clean; added `libarchive-tools` so the export ZIP cross-check runs). The first run (29f537a, run 39193648120) was **not started by GitHub: the account is locked for a billing issue**. Clear it in GitHub → Settings → Billing, then re-run the job; expect to adjust the workflow on its first real run. Still open: a `cargo test` job for `src-tauri` (needs the webkit2gtk packages on Linux)

## Business types (session 17)
- ✅ Sample items follow the type (session 22): a RETAIL trial gets shop items, the others the café set.
- ✅ Role templates follow the type (session 22): a RETAIL sign-up gets no Restaurant Manager / Kitchen Crew; changing to RESTAURANT/HYBRID adds them. ⬜ Cashier and branch-manager templates still hold `restaurant.orders`/`kitchen.operate` in a retail shop (harmless; the role editor lists them), and existing RETAIL businesses keep the restaurant roles they were given.
- ✅ `/me` carries the plan's `features` (session 22); the admin hides the Restaurant area, its guide part, a second legal entity and integrations the plan lacks, with the reason; the till hides the kitchen display and server mode. ⬜ The till's Tables tab stays for a restaurant-type business after a downgrade on purpose (printed bills must still be paid).
- ⬜ Race: an order opened in the same instant the owner switches to RETAIL can slip past the open-orders check (`assertFeature` reads the type without a row lock, to keep restaurant writes from contending on the tenant row). The order stays readable; a BILLED one can still be paid (`createFromBill` does not check the type or plan, on purpose: refusing payment for food served is worse), other changes need switching back.
- ✅ Selling by weight: `POST /v1/products` refuses `soldBy: WEIGHT` for a RESTAURANT business (session 25). ⬜ Scale-label lookups still resolve a WEIGHT product created before (or under another type).

## User guide (session 18)
- ✅ Drawer variance approval has a screen (session 18, second part): admin Drawer counts (`/shifts`) and the shift page; see STATUS.
- ⬜ Branch-scoped managers cannot read `/members` (it needs `members.read` business-wide), so other document pages show “—” for people: pay-ins/outs on the shift page, sale and return pages, transfers. Shifts now carry their own names (`openedByName`, `countedByName`, `approvedByName`); do the same for the other documents, or let `/members` answer a branch-scoped reader with the members of their branches.
- ⬜ Approval is admin only; the till's close screen says where it happens. A second manager at the till (PIN) is not built.
- ⬜ The guide copy is written from the screens' own labels; when a label changes, the guide line quoting it does not fail any test. Review the guide (EN and FIL) with each UI change, and with the native speaker's FIL review.
- ⬜ No screenshots or short videos in the guide yet (text only); worth adding once the brand (Salapi is provisional) settles.

## Phase 1 — Platform foundation
- ⏳ Real email provider (prod boot refuses the dev mailer; invitations and password reset use DevMailer) — D2
- ⬜ Catalog: bundles/composites; product images (needs S3 adapter); batch/expiry & serial tracking and UoM conversions (see Phase 3)
- ⏳ Billing: PayMongo billing integration (grant `platform_set_subscription` to it) — D6; feature flags enforced once restaurant/multi-entity features exist; per-tenant entitlement overrides
- ⏳ Filipino copy review by a native speaker (VAT status and subscription states are translated since session 10; everyday loanwords such as Journal entry, Debit/Credit, Draft, Takeaway are kept in English on purpose until reviewed)
- ⏳ OTel SDK + exporter — D1 (hosting)
- ⬜ Typed OpenAPI response schemas

## Phase 2 — Retail transaction engine
Slice 1 (tax):
- ⏳ SC/PWD sign-off by a PH tax professional (MVP gate #6)
- ⬜ 5 % BNPC / NAAC / Solo Parent schemes (rules unverified)
- ⏳ Invoice-level rounding option: ADR-0008 leaves it unimplemented until the tax adviser answers what the BIR expects (question 6); the engine rounds per line (`roundingLevel: 'LINE'` in `@1pos/tax`), and the option would become a versioned `tax_profiles` column

Slice 3 (payments):
- ⏳ PayMongo adapter + webhooks (needs sandbox keys) — D6

Slice 4 (voids/returns):
- ⬜ Refunds to card/QR (needs PayMongo)
- ⏳ Cross-branch returns: a credit memo issued at another BIR-registered branch (its own branch code and return series) against this branch's invoice, and which branch's books carry the reversed sale, are tax-adviser questions. Design once answered: same legal entity only; refund permission and the drawer at the processing branch; stock back into the processing branch at the sale's cost; the POS finds the sale by its reference across the entity (today `sales.read` is checked at the selling branch)

Slice 5 (reports):
- ⏳ Z-readings (session 16, ADR-0009 amendment) are not BIR-accredited: the official field format, grand-total digit length and whether a reading may be taken from the admin rather than at the terminal are tax-adviser questions (PH_COMPLIANCE_ASSUMPTIONS §5)
- ⏳ An offline sale delivered after its day's Z-reading is in no reading (readings are by local day and go forward). Options: count it in the next reading as a late sale, or refuse a Z while the register's tills have undelivered sales (needs a fresh sync status). Tax adviser's call
- ⬜ X-readings (intraday, unlimited) as their own document; the shift report covers it today

Slice 6 (POS browser checkout):
- ⬜ CSP response header in production hosting
- ⬜ Customer display on the desktop till (a second Tauri window); browser mode has one since session 16
- ⏳ Price-embedded scale labels (weight labels are read since session 16): which format the scales print, and whether a re-priced total may differ from the label by a centavo, is the user's call

Phase-level:
- ✅ `@1pos/pricing` promotions (session 26, ADR-0021; open items under Session 26)
- ⬜ Invoice sequences (dev series only today)

## Phase 3 — Inventory, purchasing, accounting
Slice 5 (admin UI):
- ⏳ Accountant review answers (ADR-0013 questions 1–10)

Phase-level:
- ✅ Supplier invoices + accounts payable (GRNI → AP, input VAT): API in ab51583 (ADR-0013 amendment), admin screens session 19. Follow-ups:
  - ✅ credit/debit notes, one payment across several invoices, voiding a mistaken payment, no manual reversal of payment or note entries (session 22, ADR-0013 amendment)
  - ⏳ EWT / BIR 2307 (accountant)
  - ⬜ A note cannot be cancelled (an opposite note corrects it), and an invoice with notes cannot be cancelled; a credit note's GRNI is computed per invoice, not linked to a particular return. Accountant to confirm the treatment (question 12 in ACCOUNTANT_REVIEW_REQUEST)
- ⬜ UoM conversions and purchase units
- ⬜ Batch/expiry and serial tracking
- ⬜ Landed cost
- ⬜ Financial exports beyond the journal CSV (e.g. a ready-made import for a given accounting package)
- ⏳ Accountant review of the default chart and posting policies

## Phase 4 — Restaurant
Slice 2 (menu foundation):
- ⬜ Modifier groups are live configuration: edits to min/max apply to published menus immediately (orders snapshot what was chosen)

Slice 3 (orders + kitchen):
- ⬜ Per-seat views and "fire course N" reminders/timers
- ✅ Kitchen printers (session 25): network/Windows ESC/POS from the desktop till, claimed per station
- ✅ Reprint a ticket (session 25: KDS "Reprint" → the printing till prints it again, marked REPRINT)
- ⬜ Floor push (session 16) at deployment (slice 7): the edge proxy must not buffer `text/event-stream` (`/v1/restaurant/stream`; the API sends `X-Accel-Buffering: no`) and must allow a 10-minute response; open streams are not yet a metric

Slice 4 (bills + checks + service charge):
- ⬜ Tips
- ⬜ Adding items after a partial payment (today: a new order once the bill settles)
- ⬜ Returns still prorate each bucket on its own (ADR-0011), unlike checks' residual-bucket proration; align if odd cents show up on partial returns

Slice 5 (restaurant reports):
- ✅ Free modifiers ("no onions") count in item performance once their order is SETTLED (session 25)
- ⏳ The DOLE distributable base (ex VAT) is pending the accountant (ADR-0014 §9)

Slice 6 (UI):
- 6a POS table service:
  - ⬜ Floor positions/shapes on a drawn plan (tiles today)
- 6c admin set-up:
  - ⬜ Drag-and-drop ordering (buttons today)
  - ⬜ A plan view of the floor (positions/shapes are stored, tiles today)

Slice 7 (exit review):
- ⬜ `sales.gross` counts a service charge ex VAT while item lines count VAT-inclusive; the receipt adds the charge VAT back, but any other consumer of `gross` (exports, a future invoice) must do the same — decide whether to store a charge's gross with VAT
- ⬜ No drill for an API restart between a check's commit and its answer (covered generically by the Phase 2 restart drill and the same idempotency path)
- ⬜ The "void vs bill" drill asserts both outcomes but cannot force each interleaving

Out of scope for Phase 4 (later):
- ⬜ Delivery orders and delivery platforms (Grab, foodpanda); unit conversions/purchase units for recipes; sub-recipes/prep production; rule-based modifier pricing; table reservations. (Tips and kitchen printers: session 25.)

Open questions for the tax adviser and the accountant:
- ⏳ Service charge base and VAT; SC/PWD share of the service charge; service charge as a liability

## Phase 5 — Offline & integrations
Slice 6 (deferred by the user's decision):
- ⏳ PayMongo adapter + webhooks (env settings done session 8; waiting for sandbox keys in `.env`) — D6
- ⏳ Invoice transmission (compliance gate)

Phase-level:
- ⏳ Desktop: offline sign-in after a restart during an outage (PIN for the shift's cashier) — a security design for the user to approve (ADR-0015 ★)
- ⬜ Desktop: signed NSIS installer + auto-update
- ⬜ Desktop: serial/COM printers without a Windows driver
- ⬜ Desktop: real printer/drawer hardware check
- ⏳ Offline SC/PWD and discounts (refused offline today) — changes an ADR-0015 ★ default; SC/PWD also waits on the tax sign-off
- ⏳ Opening a shift offline — changes an ADR-0015 ★ default (the user's decision)
- ✅ Snapshot paging for large catalogues (Phase 6 slice 5, session 11)
- ⬜ Printer status (paper out, cover open) needs the device's status bytes (DLE EOT) through the shell
- ⬜ Receipt logo/QR images (ESC/POS raster) when a design asks for them

## Phase 6 — Pilot readiness
Slice 1 (account security):
- ⏳ CSP for POS browser hosting: set by the hosting (D1, slice 7); the admin has a nonce CSP since session 16
- ⬜ WebAuthn/passkeys

Slice 2 (platform hardening):
- ⬜ Accepted dev-only advisory: esbuild ≤ 0.24.2 in drizzle-kit (re-checked 2026-10-19: still there; re-check when drizzle-kit updates)
- ⏳ Run the security gates automatically (needs CI, D3)
- ⏳ T5 manager approval above a refund amount at the till (a second person): needs the user's thresholds. The refund watch report is done (session 16)

Slice 3 (monitoring):
- ✅ Backup-age metric and alert (slice 4, session 11)
- ⬜ Billing failure metrics (no billing integration yet, D6)
- ⏳ OTel traces/exporter — D1
- ⏳ DEAD letters are a CLI only: a screen needs a platform console for Tilvara operators, which does not exist (the user's decision)

Slice 4 (backup and restore):
- ⏳ Point-in-time recovery (WAL) and the off-site copy with a retention lock: D1. Until then RPO = time since the last daily backup, and online sales after it are lost in a disaster
- ⏳ Scheduling the daily backup and the monthly drill on a real host (slice 7; the runbook gives the commands)
- ⬜ Drill against managed Postgres (no superuser; restore a PITR copy): after D1, runbook section ready
- ⬜ Production RTO: measured on the D1 staging size (only the dev-machine figure exists: 5.6–18.2 s for 2.7 MB)
- ⬜ The smoke business the drill creates stays in a restored database: archive it after a real restore (runbook step 4)

Slice 5 (performance):
- ⏳ Re-measure on D1 staging. On this laptop with 2 API instances these were missed:
  - checkout p99: 1.6 s against a 1 s target;
  - sync of 50: 4.4 s typical, 5.9 s worst, against 5 s.
  The tails cluster in 1–2 s windows while both event loops stay calm (DB/disk side; Docker Desktop fsync 2–15 ms).
- ⬜ Slice 7 sizing: at least 2 API instances. One instance is CPU-bound at pilot load: ~29 checkouts/s, with p95 targets missed.
- ⬜ Once in session 15, `catalog.test.ts` failed in setup ("1 failed | 16 skipped") with unchanged code, just after the concurrent-query guard went in; 9 reruns and two full API runs passed, and the guard never fired. If it recurs, the printed `concurrent query on one pg client` line names the query. The guard covers the API suites only (the worker and database suites have no `Promise.all` over a client today)
- ⬜ Fewer statements per request: a lookup is 14 (auth context + 5 sequential reads), a 3-line checkout 47. Merge the lookup reads; cache the auth context per token for a few seconds.
- ⬜ `platform_metrics()` takes ~90 ms on the load DB (100k items, a few thousand sales); watch it as data grows (alert `OneposBusinessGaugesSlow`).
- ⬜ `offline-engine.test.ts` "answers lost…" failed once in the session-16 gate at its first snapshot fetch (`fetch failed` with the simulated network up; probably a kept-alive socket closed under load); 3/3 alone right after. Watch it.
- ⬜ `monitoring.test.ts` "is its own listener" failed once right after the offline drills in the same run (`onepos_db_up` not yet 1 on the first scrape); it passed alone and in the final full gate. Watch it.

Slice 6 (onboarding and support):
- ⏳ Anonymisation job for a business whose retention period has ended (offboarding runbook step 5); until then businesses stay on hold, read-only. Periods pending the DPO
- ⏳ Object storage for exports (pre-signed URLs, lifecycle deletion) — D1. Until then `DevFileStorage` in `FILE_STORAGE_DIR` (default: the OS temp folder) and links served by the API
- ⬜ No ZIP64: an export over 4 GiB or 65,535 files is refused (far beyond pilot sizes)
- ⬜ Support access: read-only only; any active staff member may use an open grant (the business sees who); no platform screen for staff (CLI)

Slice 8 (runbooks and privacy pack). The privacy items come from the personal-data inventory (privacy README §3):
- ⏳ DPO review of the privacy pack (`docs/compliance/privacy/`): the PIC/PIP split, whether SC/PWD records are sensitive, NPC registration, retention periods, the 24-hour notice target, hosting abroad (D1). Release gate G6
- ⏳ Purge jobs in the worker for `user_sessions` (incl. user agent), `password_reset_tokens`, `email_change_tokens` (holds unconfirmed addresses), `member_invitations` and delivered `outbox_events`; today all are kept for ever. Periods proposed in the retention schedule, pending the DPO
- ⏳ Till: no local purge of offline sales once recorded in the cloud (`till.sqlite` keeps them for ever); period pending the DPO
- ⏳ Anonymisation job for closed accounts (`users.closed_at`) once no business's records within their retention period name the person; pending the DPO's periods. Until then a closed account's email stays taken (signing up again with it answers `EMAIL_UNAVAILABLE`; ops can `account-enable` it)
- ⬜ No correction document for SC/PWD beneficiary name or ID number on a recorded sale (append-only); needs the tax adviser's view of what a correction must show
- ⏳ Takeaway customer names (`restaurant_orders.customer_name`) are never cleared; period pending the DPO
- ⬜ Log redaction works on field names; free text in a log *message* string is not caught. Rule: log ids, never names or emails, in messages
- ⬜ No account page in the POS (a cashier with POS-only habits corrects their name or closes their account in the admin)
- ⬜ Error references: the POS shows the first 8 characters of the correlation id (search logs by prefix)
- ⬜ Payment payout posting (Card/QR clearing → bank, fees) and refund/chargeback procedures: with the PayMongo adapter (D6)

The remaining Phase 6 slices (7 deployment, 9 UAT/pilot) are planned in BACKLOG.md. Decisions waiting on the user: D1 hosting provider/region, D2 email provider, D4 pilot businesses, D5 invoicing during the pilot (tax adviser), D6 PayMongo keys.
