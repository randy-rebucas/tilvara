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
- ⬜ Plan prices are still placeholders (`0.0000`); the plan contents were decided in session 21 (Starter: none; Growth: multi_entity, advanced_reports; Enterprise: all three).
- ⬜ Watch: `offline-sync.test.ts` failed once with `TAX_PROFILE_MISSING` in a full gate run (session 20) and passed on its own. The likely cause is the Docker VM clock running ~1 s off the host around a profile's effective time. Two billing tests failed the same way and their tolerance was widened. If it recurs, give the fixture's tax profile an earlier effective time.
- ⬜ Offline sales after a lapse (session 21): a till that stays offline keeps selling on its last writable snapshot for up to `OFFLINE_WINDOW_HOURS` after a lapse or suspension, and those sales are recorded (audited `offline_sale.recorded_while_read_only`); that bound is the posture accepted. Snapshots issued before migration 0080 count as not writable.
- ⬜ Weighing-scale and barcode-scanner adapters (§5.2; manual weight, scale labels and keyboard-wedge work today).

## Audit 2026-10-21 (session 31)
Full write-up: [AUDIT-2026-10-21.md](AUDIT-2026-10-21.md). Every defect (§2) and every work item (§3) was fixed in session 31, and decisions A1–A6 were taken as recommended (§4, the user asked to fix them all). Migrations 0107–0109.
- ✅ Moot since 2026-10-25: VOID kitchen slips, voided-check re-pay, overstays and machine cycles were removed with their industries. Every other suite passed after the audit (audit §7).
- ✅ A1 is moot: service notes and appointments were removed on 2026-10-25 (session 33; migration 0112); question 8 is marked moot.
- ✅ A3 for laundry is moot: laundry was removed on 2026-10-25 (session 32), so `laundry.dispose` no longer exists and HYBRID branch managers need no two-step sign-in for it.
- ⏳ A5: a return of a sale paid partly with store credit gives credit back in proportion to what credit paid, not credit first. The accountant to confirm: question 13 in `accounting/ACCOUNTANT_REVIEW_REQUEST.md`.

## Audit and cleanup (session 34, 2026-10-26)
Latent: none of these has a row on the dev DB, and there is no production DB yet. Fix with a migration only if one appears.
- ⬜ `api_keys_scopes_check` was re-added `NOT VALID` (0110–0112), but Postgres checks it on every UPDATE: a key made before 0110 still listing `laundry.read`, `lodging.read` or `appointments.read` would fail `auth_api_key` (it notes `last_used_at`) and could not be revoked. Fix: revoke such keys and allow retired scopes on revoked rows only.
- ⬜ A JOB_ORDER or FOLIO payment intent from before 0110/0111 still PROCESSING/UNKNOWN can be neither reconciled (the transition trigger refuses non-SALE purposes) nor cancelled, and blocks its shift's close; a SUCCEEDED one never used by its document cannot be cancelled either.
- ⬜ An offline envelope recorded before 0111 whose answer never reached the till, re-sent by an updated till, loses `choices`/`kitchenNote`/`menuVersionId`/`pickupName` when parsed, so its hash differs: answered REJECTED `TXN_ID_REUSED` instead of RECORDED. A till still holding a pre-0112 snapshot could sell an archived package item offline until the snapshot refreshes.
Clean-up left:
- ⬜ `journal_entries_source_check` (and the TS schema) still allows `SALE_TIP_REFUND`, though 0113 deleted every such entry; drop it with the next migration that touches the check.
- ⬜ No integration test returns an old sale paid with a retired tender (`TENDER_RETIRED`, unit test only) or an old sale with `sale_charges`.
- ✅ The business-type change path is gone (session 36): `PATCH /v1/business` renames only; a `businessType` beside a name is dropped, alone it is 400.
- ⬜ Kept as scaffolding: `PERSONAL_KEYS` for retired fields (over-redaction is harmless), the sale-side `serviceCharge` in `salePosting`.

## Extensions (session 35, ADR-0026)
- ⬜ No extension ships yet; pharmacy is the first planned (its own slice: manifest, migration, module, screens, guide, E2E).
- ⬜ Hook points not built until an extension needs them: extension webhook topics (`WEBHOOK_TOPICS`), API-key scopes, report pages, receipt lines, checkout hooks in `record()` beyond `assertExtension`, sample items per extension.
- ⬜ The till takes its extension list from `/me` at sign-in; the snapshot's `extensions` is not read by the till yet (nothing offline depends on it until an extension's till screen does).
- ⬜ A plan downgrade or an extension withdrawn from the catalog does not bump the catalog version (switching does), so a till shows the extension's screens until its next snapshot refresh (≤ 10 minutes online); its writes are refused by the server meanwhile.
- ⬜ `tenants.business_type` (always RETAIL) and `businessType` on `/me` are kept for older tills; drop them in a later migration.

## Retail fit audit, per area (session 36, 2026-10-26)
The user audits one area at a time for what does not fit a retail shop.
- ✅ Subscription (Plan, Business, Extensions, Your records, Support access, Integrations; copy, guide, API, plans, scopes, topics, export lists): nothing left from the removed industries. Fixed: the business-type update path; the Plan tab now lists what the plan includes (features and allowed extensions; `GET /v1/subscription` adds `plan.extensions`); the tabs show only what the person may read.
- ⬜ The Subscription band item needs `subscription.manage` or `tenant.manage`: a member with only `integrations.manage` cannot reach Integrations from the band.
- ✅ Team (members, invitations, roles, member and role pages, forms, permission catalog and role templates, copy, guide, audit filter): nothing left from the removed industries. Fixed: the invite form no longer offers archived roles; a member with access to one legal entity shows its name (was `LEGAL_ENTITY`); the access hint names legal entities; Members and Invitations use `RecordTable` (stacked on a phone).
- ⬜ By design (0112): 8 dev businesses keep "Pharmacist" / "Pharmacy Assistant" as their own custom roles because members hold them (retail codes only now); the owner may rename or archive them. The audit log keeps entries of the removed industries as history (append-only).
- ✅ Locations (entities, branches, registers, terminals, entity page and tax registration, forms, schemas, tables, copy, guide): nothing left from the removed industries. Fixed: the pairing panel and the terminals list show the terminal id the desktop till asks for (the admin showed only the key, so a till could not be set up from the admin alone); a register with an open shift cannot be archived (409 `SHIFT_OPEN`); revoking a terminal asks why (was a fixed "Revoked from admin"); entities and registers on `RecordTable`, terminals as rows.
- ✅ Offline sales (page, till health, review tabs, envelope schema, flags, copy, guide): the `PRESCRIPTION_REVIEW` flag removed from the page, EN/FIL copy and the API comment (the server cannot give it; no sale carries it). A refusal code the screen has no words for now reads `off.why.other` in the reader's language with the server's detail; `ARCHIVED` and `TAX_PROFILE_MISSING` got words though neither is reachable today (archive order + open-shift guard; every entity has a profile). Kept on purpose: the envelope's retired fields (tips, staff, prescriptions) → VALIDATION_FAILED.
- ⬜ The `off.why.other` fallback was not seen rendered: no reachable code produces it on the dev DB (editing a quarantined row by hand was declined).
- ✅ Reports (all 15 reports, chrome, CSV export, API queries, copy, guide): retail. Tender methods now read in words everywhere (`tenderLabel`, `apps/admin-web/src/lib/tenders.ts`, `tender.*` EN/FIL: By tender, Payments to check, Z-reading, the sale page, CSVs), retired ROOM_CHARGE / JOB_DEPOSIT as "… (no longer offered)"; the guide lists Promotions and Sizes and colours; the SC/PWD book no longer returns `purchase_booklet`. Kept as history: By product's service-charge line (only when old charges fall in range), the ROOM_CHARGE refund share in `refund-parts.ts`, the `purchase_booklet` column and its receipt field.
- ✅ Books (journal, trial balance, chart, periods, entry page, forms, ledger): migration 0116 deleted the lodging/laundry accounts no chart posted to (1,724 on the dev DB; 4110 Cancellation fees everywhere) and archived the 82 that were posted to (balances and history stay in the trial balance; they leave the pickers); 2200 Service charge payable left `DEFAULT_CHART`, deleted where unused (283), active in the 25 charts that took charges. History entries already read "(retired)".
- ⬜ No way to archive an account: the API has `POST /v1/accounts` only (offered to the user as an optional addition, not built).
- ✅ Purchasing (orders, receipts, returns, suppliers and their catalog, supplier invoices, notes and payments, aging; forms, copy, guide, API, dev data): nothing left from the removed industries. Fixed: receiving without an order from the admin ("Receive without an order", with a Goods receipts list on Purchasing); receiving asks for the expiry date and lot only on items that keep expiry dates (`tracksExpiry` on order lines); the goods receipt shows each line's expiry and lot; the lot box takes 40 characters like the API; two guide lines.
- ⬜ Supplier payments have no cash method (bank transfer, check, other; they credit the bank): a delivery paid in cash from the drawer goes through the till's pay out and does not settle the invoice. Needs a decision on the account (drawer cash vs petty cash).
- ⬜ The Purchasing returns and receipts lists cover active branches only: an archived branch's documents are reached from their order or receipt.
- ✅ Inventory (ten tabs, document pages, forms, copy, both guide parts, API, lot trigger): a lot hold now stops counter sales at every branch, not only where expired stock is blocked (migration 0117; offline sales flagged as before); the expired-stock setting has two choices (a branch never set is Allow); "Used in recipes (no longer offered)", no strips in the batch trace, holds copy and guide reworded, the Inventory guide points to the packs/expiry/recalls part; the adjust form shows expiry/lot only in shops with dated items. Kept as history: the 25 old consumption movements on the dev DB.
- ⬜ The till's new chip words ("Expired or on hold · n sellable") were not seen on a till (POS E2E not run).
- ✅ Prices (price lists, promotions, forms, copy, guide, API, `@1pos/pricing`): nothing left from the removed industries. Fixed: the price table stacks on a phone (`RecordTable`); the set-price pick-list says Item; the guide line for setting a price matches the screen.
- ⬜ A price list cannot be archived (no API route): a list made by mistake stays as a tab. Offered as optional, not built.
- ✅ Products (five tabs, product page and forms, categories, units and tax, quick keys, labels, copy, guide, catalog API, sample set): migration 0118 archived the removed trades' sample items (26 on the dev DB); the product list stacks on a phone; "Add product" can make an item without stock.
- ⬜ By design: owners' own service items from the removed trades stay on sale until the owner archives them (~150 on the dev DB: "Haircut", "Standard — room night", "Wash per load", …).
- ✅ Overview (steps, plan card, tiles, prices in force, sample card, copy, the "Getting started" guide part): nothing left from the removed industries. Fixed: the register step no longer waits for a paired terminal (pairing for offline sales shown as a hint); "Products & prices" starts in Products when there are none; the header shows the branch's time zone.
- ✅ Sales and Shifts (sale page, Drawer counts, shift page, redirects): old lodging/laundry drawer movements now read in words, marked retired; "Open now" on Drawer counts; a back link on the shift page; old choice lines indented on a phone. Kept as history: service charges, choice lines and retired tenders on old sales.
- ✅ Customers (list, customer page, forms, copy, guide, API): nothing left from the removed industries. Fixed: a member who may only read customers is no longer offered "Record consent" (refused by the API), only "Withdraw consent"; the purchases list pages past 50.
- ✅ Audit (the audit log): 18 more families in the "What" filter; record types in words with links to their pages. Kept as history: the removed trades' entries, with their codes.
- ⬜ The "What" column shows the action code (over 100 codes); not put in words.
- ⬜ Next areas to audit: the user's call (left: Help, the till).

## Session 33 — retail only (2026-10-25)
The user removed the GROCERY, SALON, PHARMACY and HYBRID business types (migration 0112): salons, recipes, tips and prescriptions went with them; packs, expiry lots, lot codes, lot holds, the batch trace and the expired-stock rule stay for every shop.
- ✅ Tips and prepaid packages still owed from before: the user chose to remove the history too (migration 0113): tip and package rows deleted, old journal entries rewritten without them, accounts 2210/2310 deleted.
- ⬜ Drawer counts closed before 0113 on shifts with cash tips keep the expected cash and variance recorded at the time; their drawer movements no longer include the tips, so Σ movements no longer equals that recorded expected cash (dev data only).
- ⬜ Held former Pharmacist / Pharmacy Assistant roles (8 on the dev DB) stay as each business's own roles with what they had left; nothing uses them.
- ⬜ A worker integration test for the `stock.expired_sold` mail (the builder `expiredSoldMail` is untested; the event is checked in `expiry-holds.test.ts`).
- ⬜ Choosing the lot at the till; cost per lot. The expiry date is taken as entered (a month-only date is not read as its last day).
- ⬜ The till does not show a pack's chain ("1 box = 10 strips = 100 pieces"). Thermal receipts put the lots on one wrapped detail line, so a lot code can break across lines.

## Session 29 — laundromats and laundry shops (ADR-0024)
- ✅ All items closed by removal: the user removed laundry on 2026-10-25 (session 32; ADR-0024 withdrawn, migration 0110). D7 (SMS provider), the down-payment accounts for the accountant, the claim policy, and the DPO rows for job orders, trips and notices are no longer needed.

## Session 28 — hotels, resorts and transient houses (ADR-0023)
- ✅ All items closed by removal: the user removed restaurants (all table service) and lodging on 2026-10-25 (session 32; migration 0111).

## Session 30 — pharmacies and drugstores (ADR-0025)
- ✅ All items closed by removal: the user removed pharmacies on 2026-10-25 (session 33; migration 0112). The kept parts (lot holds, the batch trace, the expired-stock rule, the pack chain) carry their open items in session 33 above.

## Session 27 — beauty salons, spas and barber shops (ADR-0022)
- ✅ All items closed by removal: the user removed salons on 2026-10-25 (session 33; migration 0112), with recipes and tips. What is still owed from before (prepaid packages, tips) is in session 33 above.

## Session 26 — retail stores and boutiques (ADR-0021)
- ⏳ Tax adviser: SC/PWD always wins over a promotion on the same line (no double discount, RA 9994 IRR). Whether the beneficiary may instead choose the promotion when it is larger is for the adviser; today the statutory discount applies.
- ⬜ Promotions by category, cart-level offers ("₱100 off ₱1,000"), coupons and loyalty, a set that cheapens a different set ("buy a shirt, socks half price").
- ⬜ One promotion per line: a line with 5 units where 3 make a multi-buy is wholly claimed by it, so the other 2 cannot join another promotion. Splitting lines per promotion would lift this.
- ⬜ A till older than this server ignores the snapshot's promotions and rings promoted items at full price; the server then refuses the total (`TOTAL_MISMATCH` → quarantined for a manager, not lost). Tills must update with the server.
- ⬜ A partial return of a promoted line refunds its share pro rata (as for any line discount); a partial return that breaks the group does not claw back the promotion.
- ⬜ Shelf locations are labels only; quantities stay per branch. Bin-level stock (quantities per shelf, moves between shelves) is not built.
- ⬜ Labels print through the browser's dialog and were checked on screen only (scale and margins on a real printer and label stock are untested). A label printer driven by the till (ZPL/ESC-POS), and the price from a scheduled price change, are not built.
- ⬜ Serial numbers, consignment, and layaway with deposits (only stock reservations exist).
- ⬜ The admin band is full (eleven tabs fit at 1440 px): Promotions, Quick keys and Labels are tabs inside Prices and Products.
- ⬜ `backup.test.ts` was not re-run in session 26 (the Docker CLI on this machine stopped answering); re-run it when Docker is back.

## Session 25 — restaurants, cafés and food trucks (ADR-0014 amendment)
- ✅ All items closed by removal: the user removed restaurants (all table service) and lodging on 2026-10-25 (session 32; migration 0111), then tips (session 33; migration 0112).

## Session 24 — sari-sari stores: packs and pieces, expiry dates (ADR-0020)
- ⏳ Opening packs posts a revaluation of pieces sold short (and rounding) to COGS, like receipts and transfers. Accountant to confirm with the next batch of questions (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`).
- ✅ A sale opens up to three levels (box → strip → piece, session 30; kept for every shop in 0112). Manual openings work at any level.
- ⬜ A purchase-order line is received with one expiry date per receipt (the receipt takes each order line once). Two dates in one delivery of an ordered item need two receipts; items off the order can be repeated on one receipt.
- ⬜ No dates on count sheets or supplier returns: a count surplus is undated, and a supplier return draws by the rule (undated first, then first-expiry-first). A damaged customer return goes back to its sale's lot, but its WASTE then draws undated stock first.
- ⬜ The till has no "Open a pack" at the counter and the counter guide has no tingi line (it does warn when only part of a quantity is sellable: expired or held) (sales open packs on the server, so the till needs none of this to work).
- ⬜ Sample items are untracked, so a trial shows neither packs nor expiry until the owner adds real stock-counted items (the GROCERY type and its sample set were removed in 0112).
- ⬜ Turning off "Keeps expiry dates" keeps the item's lots; they are drawn as stock goes out but no new dates come in.

## Session 23 — till quantities and stock movements
- ⏳ Damaged returns now move their cost from COGS to Spoilage and waste (RETURN then WASTE). Accountant to confirm this treatment (add to `docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md` with the next batch of questions).
- ⬜ Price approvals made before migration 0084 have no quantity (no limit); they expire within minutes, so nothing is left to do once the pilot starts on 0084. A till build older than session 23 cannot ask for a price (the API now requires `quantity`).
- ⬜ Counter "+"/"−" and rescans have no E2E check.

## Phase 0 — Repository & architecture
- ⏳ CI: `.github/workflows/ci.yml` is written (session 16) and main is pushed to `origin` (github.com/randy-rebucas/tilvara, public). Pre-flight checked locally on 2026-10-19 (lockfile, LF line endings, compose container name for the backup test, `onepos_test` from the init script, `.env.example` = dev `.env`, `security:audit` clean; added `libarchive-tools` so the export ZIP cross-check runs). The first run (29f537a, run 39193648120) was **not started by GitHub: the account is locked for a billing issue**. Clear it in GitHub → Settings → Billing, then re-run the job; expect to adjust the workflow on its first real run. Still open: a `cargo test` job for `src-tauri` (needs the webkit2gtk packages on Linux), the E2E suites and the restore drill

## Business types (session 17)
- ✅ Retail only since 2026-10-25 (migrations 0110–0112): the type, role templates, sample items and plan-aware screens left for other types went with them. The `business_type` column stays so a type can come back.

## User guide (session 18)
- ✅ Drawer variance approval has a screen (session 18, second part): admin Drawer counts (`/shifts`) and the shift page; see STATUS.
- ⬜ Branch-scoped managers cannot read `/members` (it needs `members.read` business-wide), so other document pages show “—” for people: pay-ins/outs on the shift page, sale and return pages, transfers. Shifts now carry their own names (`openedByName`, `countedByName`, `approvedByName`); do the same for the other documents, or let `/members` answer a branch-scoped reader with the members of their branches.
- ⬜ Approval is admin only; the till's close screen says where it happens. A second manager at the till (PIN) is not built.
- ⬜ The guide copy is written from the screens' own labels; when a label changes, the guide line quoting it does not fail any test. Review the guide (EN and FIL) with each UI change, and with the native speaker's FIL review.
- ⬜ No screenshots or short videos in the guide yet (text only); worth adding once the brand (Salapi is provisional) settles.

## Phase 1 — Platform foundation
- ⏳ Real email provider (prod boot refuses the dev mailer; invitations and password reset use DevMailer) — D2
- ⬜ Catalog: bundles/composites; product images (needs S3 adapter); serial tracking and UoM conversions (see Phase 3)
- ⏳ Billing: PayMongo billing integration (grant `platform_set_subscription` to it) — D6; feature flags enforced once multi-entity features exist; per-tenant entitlement overrides
- ⏳ Filipino copy review by a native speaker (VAT status and subscription states are translated since session 10; everyday loanwords such as Journal entry, Debit/Credit, Draft are kept in English on purpose until reviewed)
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
- ⬜ Landed cost
- ⬜ Financial exports beyond the journal CSV (e.g. a ready-made import for a given accounting package)
- ⏳ Accountant review of the default chart and posting policies

## Phase 4 — Restaurant
- ✅ All items closed by removal: the user removed restaurants (all table service) and lodging on 2026-10-25 (session 32; migration 0111). Recipes went with salons in 0112; earlier sales keep their service charges and choice lines.

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
- ✅ Takeaway customer names: moot, `restaurant_orders` was dropped on 2026-10-25 (migration 0111)
- ⬜ Log redaction works on field names; free text in a log *message* string is not caught. Rule: log ids, never names or emails, in messages
- ⬜ No account page in the POS (a cashier with POS-only habits corrects their name or closes their account in the admin)
- ⬜ Error references: the POS shows the first 8 characters of the correlation id (search logs by prefix)
- ⬜ Payment payout posting (Card/QR clearing → bank, fees) and refund/chargeback procedures: with the PayMongo adapter (D6)

The remaining Phase 6 slices (7 deployment, 9 UAT/pilot) are planned in BACKLOG.md. Decisions waiting on the user: D1 hosting provider/region, D2 email provider, D4 pilot businesses, D5 invoicing during the pilot (tax adviser), D6 PayMongo keys.
