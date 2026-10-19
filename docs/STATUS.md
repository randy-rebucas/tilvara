# Tilvara — Status

_Last updated: 2026-10-19 (session 18 — user guide in the admin and the counter. Session 17 — business types. Session 16 — all LEFTOVER items that need no decision, in batches. Session 15 — LEFTOVER items without decisions: one query per transaction at a time, outbox leases, KDS un-bump, sync budget, test DB reset, server-rendered page scan. Session 14 — slice 8 follow-up: log redaction, own account (name, email, closure), account-disable CLI, MFA key rotation, error references. Session 13 — slice 8 runbooks and privacy pack. Session 12 — slice 6 onboarding and support: support access, data export, offboarding runbook, trial sample items. Session 11 — slice 4 backup and restore drill; slice 5 performance. Session 10 — slice 3 monitoring; LEFTOVER batches. Session 9 — Phase 6 planned (ADR-0016); slices 1–2)_

## Current phase — Phase 6: pilot and commercial readiness (started session 9)
Plan: `docs/decisions/ADR-0016-pilot-readiness.md`. It has nine slices in dependency order:
1. account security;
2. platform hardening;
3. monitoring;
4. backup and restore;
5. performance;
6. onboarding and support;
7. deployment;
8. runbooks and privacy;
9. UAT, compliance review and pilot.

Runbooks: `docs/operations/README.md`. Privacy pack: `docs/compliance/privacy/README.md`.

The exit criterion is judged on real pilot days and needs the user's decisions D1–D6 (listed in the ADR and in "Next task"). **Slices 1–6 and 8 are done** (below), and the slice 8 privacy gaps that need no decision were closed in session 14. Next: slice 7 (deployment) needs D1 and D3; slice 9 (UAT and pilot) needs D4–D6. The privacy pack waits on the DPO's review (G6), and so do the purge and anonymisation jobs (they need the retention periods). Other open LEFTOVER items that need no decision can go on meanwhile.

## Session 18 — user guide (admin and counter)
The user asked for a user guide in both the admin and the desktop/browser counter (SPEC §13 "contextual help").
- **Admin** `/help`: one part per area in set-up order (getting started, products, prices, inventory, purchasing, restaurant, reports, books, offline sales, locations, team, subscription, your account, the counter app); numbered steps that quote the real button labels, "good to know" lines, and an "Open …" link to the area. Parts follow the business type (no restaurant part for RETAIL, no selling-by-weight line for RESTAURANT); areas the role does not open are still explained and tagged "Not in your role". A **? button in the band** (beside the names) opens the part about the current page (`topicFor`, longest prefix; a restaurant page in a RETAIL shop opens Subscription, where the type is changed); the overview checklist links to it. The tab list moved to `src/lib/nav.ts` so the band and the guide share it.
- **Band fit**: the button first pushed the twelve tabs 38 px over at 1440 px (992 > 954, measured). Fixed by putting it in the account block's 8 px group, capping the names at 96 px from lg (was 128; full name in the tooltip) and the band gap 20 → 16 px from lg. The E2E asserts it with a long business name.
- **Counter**: a ? button in the band (and **F1** anywhere) opens the guide over the current screen, at the part for the stage or tab (getting started, sell, this shift, close shift, tables, kitchen display, desktop till, when something goes wrong); Esc/Back return with the cart intact. Tables and kitchen are left out for RETAIL. While it is open the counter's F-keys are held back (capture phase).
- **Defect found by the E2E (mine)**: `useEffect(() => scrollTo(topic))` returned `scrollIntoView`'s value, which this Edge returns as a Promise; React called it as the cleanup and the whole counter unmounted on closing the guide. Now a block body.
- Copy: EN + FIL in each app's catalog (`guide.*`); the FIL needs the native-speaker review like the rest.
- **Verified (session 18)**: `pnpm build` 14/14; `pnpm lint` clean; `tsc --noEmit` admin and POS; unit admin **27/27** (new `guide.test.ts` 7: EN+FIL for every line, no orphan copy, every band tab maps to its part, nested paths, RETAIL/RESTAURANT filtering, role marking), POS **17/17** (new `guide.test.ts` 3). E2E on a fresh API (:4322, rate limits off), admin `next start` (:3322) and POS preview (:3332): new **`test:e2e:web:guide` 22/22** (first run 20/22: the band overflow above, and my own check comparing uppercase-styled text); `test:e2e:pos` **41/41** (+7: opens at Sell, RETAIL leaves out tables/kitchen, Esc returns to the same cart and F8 behind the guide did nothing, F1, Filipino, Back; earlier runs failed on the cleanup defect above and on a check that sent the key to `window` itself, where a page's listeners run in registration order, instead of to the focused element as a keyboard does); regression after the band change: `test:e2e:web` 46/46, `web:account` 27/27, `web:security` 26/26, `web:backoffice` 49/49.
  - Not re-run: desktop till (`test:e2e:desktop`; the guide is the same React code), restaurant/floor/kitchen suites, `review.mjs` captures.

**Second part — approving a drawer count (the gap the guide found).** The API had `POST /v1/cashier-sessions/:id/approve-variance` (a different person with `cash.reconcile`; tested) but no screen called it, so a short or over drawer stayed "Waiting for a manager" for good.
- **Admin Drawer counts** (`/shifts`, no band tab: the band is full): "Waiting for approval" (register · branch, cashier, who counted and when, expected, counted, signed difference; "Open shift" and "Approve the count" with a required note) and "Recently closed" (approved by, note). Whoever counted a drawer is told someone else approves it (no button). Reached from an overview notice (managers only: "Drawer counts waiting for approval: n") and the Offline page; the shift page has the same approve form. Guide part "Drawer counts" (`/help#drawers`, the help button on `/shifts…`); the till's close message and its guide say where approval happens.
- **API**: `GET /v1/cashier-sessions` now carries each shift's `reconciliation`; list and detail carry `openedByName`, `countedByName`, `approvedByName`.
- **Defects found by the new E2E (pre-existing, both would have stopped the feature)**: the admin's BFF proxy allow-list had no `cashier-sessions` route, so the approve form answered "Not found" (now exactly `cashier-sessions/<uuid>/approve-variance`); a branch manager (`cash.reconcile` and `members.read` at one branch) could not read `/members`, so the page could not say who counted (“—”) — names now travel with the shift (other documents: LEFTOVER).
- **Verified**: `pnpm build` 14/14; lint clean; `tsc` api/admin/POS; unit api 52/52, admin 27/27, POS 17/17; integration `sales.test.ts` **36/36** (list carries the count and names, approved drawer leaves the CLOSED list, approver's name differs from the counter's), `isolation.test.ts` 10/10. E2E on a fresh API (:4322), admin (:3322), POS preview (:3332): new **`test:e2e:web:drawers` 19/19** (first run 10/18 on the two defects above), `web:guide` 22/22 (+ Drawer counts part), `web` 46/46, `web:backoffice` 49/49, `pos` 41/41. OpenAPI regenerated (unchanged: same routes).

## Session 17 — business types
The user asked that a business only see the features its type supports. Decisions (user, 2026-10-19): three types, RETAIL / RESTAURANT / HYBRID ("Both"); RETAIL is refused restaurant writes on the server as well as hidden; RESTAURANT hides selling by weight (screens only); existing businesses become HYBRID so nothing disappears.
- **Schema**: `tenants.business_type` (CHECK, default HYBRID; migrations 0070 DDL, 0071 hand-written: `UPDATE (business_type)` for `onepos_app`, `SELECT` for `onepos_worker`). Dev DB migrated (0068–0071, with the uncommitted supplier-invoice work): 315/315 businesses HYBRID.
- **API**: sign-up takes `businessType` (optional, default HYBRID for older clients); `/me` `activeTenant.businessType`; `GET /v1/business` (any member) and `PATCH /v1/business` (`tenant.manage`, audited `tenant.business_type_changed`, 409 `OPEN_RESTAURANT_ORDERS` when going RETAIL with OPEN/BILLED orders). `assertFeature(db, 'restaurant')` refuses a RETAIL business with 403 `BUSINESS_TYPE_EXCLUDES_FEATURE` before the plan check, so every restaurant write already gated by the plan is gated by the type; reads stay open (records survive a change). The data export manifest names the type.
- **Admin**: type choice on sign-up; Subscription → Business tab (change the type); the Restaurant tab and the restaurant report group are hidden for RETAIL, and their URLs show a notice with a link; the product form and list drop "Sold by" for RESTAURANT (unless an item already sells by weight). EN + FIL.
- **POS**: RETAIL hides "Work the floor", the kitchen display entry and the Tables tab, whatever the person's permissions.
- **Verified (session 17)**: `pnpm build` 14/14; `pnpm typecheck` (api, admin, POS); `pnpm lint` exit 0; `turbo run test --force --concurrency=4` 24/24 tasks; integration: new `business-type.test.ts` **5/5**, with `auth`, `menu`, `recipes`, `billing`, `support-onboarding`, `account-privacy`, `isolation` (+`/v1/business` in the read sweep) — 84/84; database `rls-catalog` + `tenant-isolation` 25/25; worker `data-export` 3/3 (its first run failed 3/3 because the shared test DB held a backlog of outbox events from the API runs ahead of its own; reruns passed 3/3 three times). E2E on a fresh API (:4321, rate limits off), admin `next start` (:3321) and POS preview (:3331): `test:e2e:web` **46/46** (+4), `test:e2e:web:restaurant` 22/22 (signs up as RESTAURANT), POS `test:e2e:pos` **34/34** (+2, signs up as RETAIL). OpenAPI regenerated.
  - Not re-run: `review.mjs` captures (now pick RETAIL at sign-up), floor/tables/kitchen/service/desktop suites (they sign up through the API, which defaults to HYBRID).

## Session 16 — "work on all leftovers"
The user asked to work through every LEFTOVER item. Items waiting on D1–D6, a reviewer (tax adviser, accountant, DPO, native speaker), provider keys or hardware stay open; the rest are taken in batches, each committed with its own tests.

**Batch 1 — pilot polish** (ADR-0016 "Amendments (session 16)"):
- **Rename gaps**: the 1POS → Tilvara rename had missed the email-change mails, account/support error messages, the export ZIP name (`tilvara-export-…`), its README and manifest `format`, and the onboarding E2E (which still expected "1POS support" and would have failed).
- **Wordmark**: at 1440 px with a long business name the last tab was 5 px out of the band again (`Tilvara` is 23 px wider than `1POS`; measured 992 > 987). Band gap 24 → 20 px from lg and the name cap 136 → 128 px. At 390 px the account block wrapped under the wordmark; it now shrinks on the wordmark's line, and the names are clamped to their box (they first overflowed over "FIL", caught by the screenshot; the E2E now checks for it).
- **Email-change link in someone else's browser**: the confirm answers `{userId}`; the BFF signs out only that account's browser.
- **References for unanswered requests**: POS and admin mint the correlation id per request; "no connection" messages carry it.
- **Metrics port**: `METRICS_TOKEN` bearer check; required in production off loopback.
- **Support reads**: one audit row per route per 15 minutes per grant (refused writes still each logged).
- **CI workflow** written (`.github/workflows/ci.yml`), not yet run (D3).
- **Verified (batch 1)**: `pnpm build` 14/14; `pnpm typecheck` 24/24; `pnpm lint` exit 0; `turbo run test --force --concurrency=4` 24/24 tasks (with the default concurrency the database unit suite timed out twice, on different tests that only read files, at 5 s under load: disk contention, not code); integration `account-privacy` + `support-onboarding` 29/29 (mutation: a 0-second window fails the new support check); E2E on the rebuilt API (:4320, rate limits off), worker and admin `next start` (:3320), POS preview (:3330): `web:account` **27/27** (+4: link opened as someone else, same account signed out, 390 band line, 1440 band), `web:onboarding` 23/23, `pos` 27/27; OpenAPI regenerated.

**Batch 2 — inventory** (ADR-0012 amendment; migrations 0060 DDL, 0061 hand-written, applied to the dev DB: the `inventory.count` back-fill reached all 568 owner/admin roles):
- **Negative-stock policy per branch** (`inventory_settings`: ALLOW / ALLOW_WITH_FLAG / BLOCK; `org.manage` only). BLOCK refuses a counter sale that would go below zero (`409 INSUFFICIENT_STOCK`, names the item; nothing written), with the balances locked through the new `app_lock_stock_balances` (the app role cannot lock a table it cannot update). Checks, offline sales and recipe consumption are flagged, never refused. The trigger marks `stock_movements.below_zero`; the movements report counts them.
- **Stock alerts**: the costing trigger writes `stock.low` (crossing the reorder point, once per crossing; switch per branch) and `stock.below_zero` (policy not ALLOW) outbox events; the worker mails the branch's stock keepers (`inventory.adjust` / `purchasing.manage` at its scope).
- **Count sheets (blind counts)**: open and freeze on hand, count (new permission `inventory.count`; a counter never receives the frozen quantities of an open blind sheet), post later as a stock count of `counted − frozen`, so sales during the count stay; or cancel with a reason. Admin: Inventory → Counts (sheets section, sheet page with per-line counts, review and post), Inventory → Settings, a "Below zero" column on Movements. EN/FIL.
- **Docs**: the 1POS → Tilvara rename had also missed the privacy pack and the runbooks (now renamed); processing register notes the stock alert mails.
- **Verified (batch 2)**: `pnpm build` 14/14; `turbo run test --force --concurrency=4` 24/24 tasks; new `inventory-policy.test.ts` **9/9** (mutation: reading balances without the lock lets both tills sell the last unit, `[201, 201]`); `rls-catalog` 10/10; `isolation` 10/10 (+6 routes, +4 smuggling cases, 3 tables); full gate `turbo run test:integration --concurrency=1 --continue --force`: database **33/33**, workers **22/22**, api **341/342**. The one failure was `offline-engine.test.ts` "answers lost…": its very first snapshot fetch, with the simulated network up, got `fetch failed` (no code path of this batch is involved); the file then passed 3/3 alone. LEFTOVER watch item. E2E on the rebuilt API and admin: new **`test:e2e:web:stock` 22/22** (its first run failed 3 checks that compared upper-cased `serial` text; the screens were right). OpenAPI regenerated.

**Batch 3 — restaurant** (ADR-0014 "Amendment: floor leftovers"; migrations 0062 DDL, 0063 hand-written, applied to the dev DB):
- **Notes per course** (`order_course_notes`, copied onto the course's tickets when fired; KDS shows them); **voiding a choice on its own** (`409 CHOICE_REQUIRED` for a group's minimum; waste of the choice only; struck on the KDS and off the bill).
- **Push to the KDS and the floor**: notify triggers → one LISTEN connection per API process → `GET /v1/restaurant/stream` (SSE, no data in it). The POS reads it with fetch and slows its polling to 30 s while it is up.
- **Prep times by hour or by item** (`?by=`; admin switch); **open orders as they stood at the cutoff** (`order_item_moves`, recorded by a trigger from now on).
- **Server mode**: "Work the floor" on the POS register picker for `restaurant.orders`, without a shift; the bill prints and says to take payment at a till. Branch lists open to `restaurant.orders` (so cashiers now see their own branch).
- **Defects in my own work, found by the gate**: the `restaurant-reports` fixture stamped items served in the future (fired now + 150 s), which the new as-of-cutoff counting rightly did not count as served; the fixture now fires them 15 minutes back. The branch-visibility test expected a cashier to see no branch, which the server mode deliberately changed; updated with the reason. Also caught by E2E: my first ticket-row markup broke the "Medium · Cheese" reading of choices (flex spans); now inline text.
- **Verified (batch 3)**: `pnpm build` 14/14; `turbo run test --force --concurrency=4` 24/24; lint clean; new `restaurant-leftovers.test.ts` **5/5** (course notes, choice void, the stream incl. cross-tenant silence and a foreign branch 404, prep by hour/item, open orders at the cutoff); isolation 10/10 (+1 route, +1 smuggling case, 2 tables); full gate `turbo run test:integration --concurrency=1 --continue --force`: database **33/33**, workers **22/22**, api **345/347**, the two fixed above then **18/18** in their files. E2E (API :4320 rate limits off, admin :3320, POS preview :3330): new **`test:e2e:floor` 13/13**, `kitchen` **22/22** (+2: a fired course with its note within 2.5 s by push, a struck choice), `tables` 32/32, `service` 22/22, `web:reports` **21/21** (+2: prep by item and by hour). OpenAPI regenerated.

**Batch 4 — offline tills** (ADR-0015 "Amendment (session 16)"; migrations 0064 DDL, 0065 hand-written, applied to the dev DB):
- **Price changes reach an online till within half a minute**: a per-business `catalog_versions` counter (statement triggers on every snapshot table), `catalogVersion` + `nextChangeAt` in the snapshot, `GET /v1/terminal/catalog-version`; the till asks every 30 s and refreshes at once (scheduled changes too, with no device clock).
- **A revoked till's queue is recoverable**: set the device up again as a new terminal on the same register; its stranded sales are recorded (audited `offline_sale.recovered`), ones delivered before revocation answer as before; any other borrowed snapshot stays `UNKNOWN_SNAPSHOT`. Runbook section 6 rewritten; the till's revoked notice says what to do.
- **Numbering after a lost or restored till file**: the snapshot carries `lastDeviceSeq`; the till continues after it, so local references never repeat.
- **`PERIOD_CLOSED` drilled** for an offline sale (quarantine → reopen → retry → recorded once).
- **Left for the user's decision** (ADR-0015 ★ defaults): offline SC/PWD and discounts, opening a shift offline, an offline PIN after a restart.
- **Verified (batch 4)**: build 14/14; unit 24/24 (pos-offline **15**: +2 outdated snapshot, +1 numbering); `offline-sync.test.ts` **12/12** (+3: closed month, catalog version incl. another business and a revoked till, recovery; mutation: accepting any terminal's snapshot on the register lets a borrowed one record); full gate: database 33/33, workers 22/22, api **350/350**; the desktop till rebuilt (`tauri build --debug --no-bundle`) and **`test:e2e:desktop` 22/22** (+1: a price changed in the back office is on the till 40 s later, proven offline; its first run failed because the step forgot the till was signed out by the restart before it). OpenAPI regenerated.

**Batch 5 — security and controls** (ADR-0016 amendments; no migration):
- **Nonce CSP for the admin**: scripts run only with the per-request nonce (`'strict-dynamic'`, no `'unsafe-inline'` for scripts); styles keep `'unsafe-inline'`; `/_next/static` gets `default-src 'none'`. THREAT_MODEL T21 now ●.
- **Refund watch** (T5): per person, returns and voids processed against own sales and the branch rate, flags HIGH_RATE / OWN_SALES; admin Reports → Sales → Refund watch with CSV.
- **Re-checked**: the dev-only esbuild advisory (still only through drizzle-kit's loader, not reachable); production audit clean.
- **Left for the user's decision**: a two-person approval above a refund amount (thresholds), a platform console for DEAD letters; the POS browser CSP is set by the hosting (D1).
- **Verified (batch 5)**: build, typecheck 24/24, lint clean, unit 24/24 (admin `report-csv` +1); new `refund-watch.test.ts` **1/1** (flags, branch scope, cross-tenant 404); `isolation` + `reports` 20/20 (refund watch in both sweeps); E2E on the rebuilt admin: `web:security` **26/26** (+2: no unsafe-inline scripts with strict-dynamic; a fresh nonce on every script; the first run failed once on "forgot password answers the same", the cold-start intermittent seen in session 10, then 26/26), `web` 42/42, `web:backoffice` **45/45** (+1 refund watch; its first run failed on my own check, which matched the page's footnote), `web:onboarding` 23/23; `security:pages` 15 pages clean.

**Batch 6a — counter and reports** (ADR-0006 amendment; no migration):
- **Print / save as PDF** for every report: a button beside the CSV, print styles that keep only the report, and a printed heading (report, branch, range, when printed). The POS bill already printed through the browser, which saves as PDF too.
- **Scale labels**: weight-embedded in-store EAN-13 read online and offline the same way; the line takes the printed weight. Price-embedded labels left for the user's decision.
- **Customer display** (browser mode): a second window fed over a BroadcastChannel (lines, total, then the change and a thank-you).
- **Defect found and fixed (pilot-relevant)**: a member given `catalog.read` at one branch (how cashiers are usually invited) could not read the business-wide catalog at all: no lookup at the till, and the Products page said "no access". Catalog reads now accept the permission held at any scope; the branch lookup checks it at the branch asked for. Found by the new scale-label test, which used a branch cashier; every earlier test used owners or business-wide cashiers. Regression test in `catalog.test.ts`.
- **Verified (batch 6a)**: unit: sync-protocol `scale.test.ts` **5/5**, pos-offline **16/16** (+1 offline label), admin `report-csv` 6/6; integration `scale-labels.test.ts` 1/1 and `catalog.test.ts` 18/18 (+1 branch cashier); E2E: `web:reports` **24/24** (+3: print button; print styles hide the band and controls and show the heading; a real PDF from `Page.printToPDF`), `pos` **32/32** (+5: the display greets, shows the lines and ₱78.40, thanks with the ₱21.60 change; a scale label rings ₱394.88).

**Batch 6b — Z-readings** (ADR-0009 amendment; migrations 0066 DDL, 0067 hand-written, applied to the dev DB):
- **Z-readings per register and local day** (fiscal gate G2; **not BIR-accredited**, and every screen says so): numbered per register, sale-number range, sale buckets, returns and voids, net, tenders net of refunds, statutory discounts by scheme, and the accumulated grand total carried forward. Refused while a shift is open, for a future day, and for a day on or before the last reading. Admin: Reports → Sales → Z-readings (register picker, take, latest reading in full, history; prints).
- **One shift across local midnight** is now tested (backdated rows instead of clock control): two business days, one shift report, two readings with the grand total carried. Closes the gap left by the Phase 2 exit review.
- **Left for the tax adviser**: the official reading format; offline sales delivered after their day's reading (in no reading today); invoice-level rounding (ADR-0008 question 6).
- **Verified (batch 6b)**: new `z-readings.test.ts` **1/1** (midnight shift, both readings, order and shift-open refusals, append-only, cross-tenant 404); `isolation` **10/10** (+3 routes, +2 smuggling paths, 1 table) and `rls-catalog` 10/10; E2E `web:backoffice` **49/49** (+4: the not-accredited notice, refused with an open shift, Z-1 with ₱33.00 grand total, a second reading refused). Full gate `turbo run test:integration --concurrency=1 --continue --force`: database **33/33**, workers **22/22**, api **353/354**. The one failure was readiness ("migration head", 503), and I caused it: I generated the next batch's migrations while the gate ran, so the API saw a newer journal than the test DB had. `monitoring.test.ts` then 13/13.

## Session 15 — LEFTOVER items that need no decision
Migrations 0058 (`outbox_extend`) and 0059 (un-bump exception in `order_items_transition`), applied to the dev DB.
- **One query at a time per transaction**: 13 `Promise.all` sites over a transaction's client (receipts, bills, menus, price lists, purchase orders, tax profiles, list views) now use `inSequence` / `mapInSequence` (`@1pos/database`). pg 8 only warned; pg 9 refuses. The API integration setup now fails any query issued while another runs on the same client, naming it (seen failing when one site was put back).
- **Sync budget from request arrival**: `receivedAt` is stamped in the first middleware, so pool waits and terminal authentication count against `SYNC_BATCH_BUDGET_MS`.
- **Outbox leases**: the worker renews an event's lease before it starts (skipping one another worker took over while earlier events in the batch ran) and every third of the lease while the handler runs. A large export is no longer made twice.
- **Intermittent tests** made order-independent: the welcome-mail tests wait for their own event; `reliability.test.ts` compares by topic.
- **`pnpm test:db:reset`**: drops and recreates `onepos_test` (639 MB → 14 MB here; the next suite migrates it).
- **KDS un-bump** (ADR-0014 amendment): `POST /v1/kitchen/tickets/:id/unbump` and an "Undo bump" button; READY → IN_PREP only, served food never comes back (the trigger still refuses that).
- **Admin**: a long business name no longer pushes the last tab out of the 1440 px band (the name is cut at 136 px from lg, full name in the tooltip); the overview checklist ends with "First sale" (opens the till when `ONEPOS_POS_URL` is set, else the sales reports).
- **`pnpm security:pages`**: signs in to a running admin and scans what 15 server-rendered pages send to the browser (the build holds no HTML for them: every page is dynamic).
- **Closed as already done**: POS menu pricing (batched in slice 5); card/QR on table checks (the bill screen uses the shared payment panel).
- **Left open on purpose**: free modifiers in item performance (needs a rule for when a free choice counts as sold); the other LEFTOVER items need a decision, a provider, hardware or are larger features.
- **Defects found in my own new tests and fixed**: both new lease tests first assumed the rival worker claimed nothing or exactly the test's event, but leftovers of earlier tests come due mid-run; and two events emitted together can tie on `available_at`, so the batch order is not fixed. They now check, per event, who ran it. Also a first nav-cap value (150 px) was still 4 px too wide (measured 992 > 988).
- **Mutation checks**: the guard catches a `Promise.all` put back in price lists; both lease tests fail without renewal; the live page scan fails (exit 1) on a planted value.
- **Verified this session (final code)**:
  - `pnpm build` 14/14; `pnpm typecheck` 24/24; `pnpm lint` exit 0; `pnpm test --force` 24/24 tasks after regenerating OpenAPI (api 52);
  - `pnpm test:db:reset`, then `turbo run test:integration --concurrency=1 --continue --force`: database **33/33**, workers **22/22** (+2 lease tests; 8 consecutive passes of the suite before), api **333/333** (+ arrival budget, + un-bump; isolation +1 route);
  - `pnpm db:migrate` on the dev DB (0056–0059); `pnpm security:bundles` self-test + 51 files clean; `pnpm security:pages` 15 pages clean;
  - E2E on the rebuilt API (:4320, rate limits off), admin `next start` (:3320) and POS preview (:3330): `test:e2e:kitchen` **20/20** (+3 un-bump), `web:account` **23/23** (+2: long name, First sale), `web:backoffice` **44/44** (+1 First sale done), `web:security` 24/24, `web` 42/42, `service` 22/22, `pos` 27/27.
  - Not re-run: restaurant admin, reports, offline, onboarding, tables and desktop suites (their paths did not change beyond the shared band and helpers covered above).
- **Not committed**: sessions 12–15 are uncommitted in the working tree.

## Session 14 — slice 8 follow-up: privacy gaps that need no decision
As built: ADR-0016 "As built — slice 8 follow-up". Migrations 0056 (DDL) and 0057 (hand-written), applied to the dev DB (58 migrations; no back-fill).
- **Log redaction of personal fields** (`PERSONAL_KEYS` beside the secrets, three objects deep); dev mailers log a masked recipient.
- **Your account** (admin `/account`, opened from the name in the band): correct your name; change your sign-in email through a 24-hour link to the new address (password, plus a code when two-step sign-in is on; every session ends when it is confirmed; the old address is told); close your account once you belong to no business (blocked now, second factor and pending links removed; anonymisation waits on the DPO). Public `/confirm-email`. EN/FIL.
- **Ops**: `support account-disable|account-enable --email … --reason … --ticket …` (audited) replaces the runbook SQL; `pnpm --filter @1pos/api mfa-rekey [--check]` with `MFA_ENCRYPTION_KEY_PREVIOUS` rotates the MFA key without re-enrolment (runbook security-incident.md 2.5.1).
- **Error references**: the admin error page (new `app/error.tsx`) shows the API correlation id as its reference, and 5xx form errors end "Reference: …"; the POS appends `Ref. <first 8>`.
- **Docs**: security-incident.md 2.1 and 2.5.1, data-subject-requests.md, processing register, retention schedule (new `email_change_tokens` row), privacy README gaps 2 and 6, THREAT_MODEL T17/T17a, operations index, `.env.example`, CLAUDE.md.
- **Defects found and fixed** (all in this session's new code or test arrangement):
  - the error page showed the reference upper-cased (the `serial` style), while log searches are case-sensitive; caught by looking at the screenshot. The E2E now compares the visible text and was seen failing on the old build;
  - my first E2E arrangement tried to remove an owner from their only business; the database refused it (`a business must keep at least one active owner`), which is right. The E2E now registers an account with no business;
  - an E2E check looked for the person's name in the band of `/account`, whose layout has no name. The check now looks at the back office band.
- **Mutation checks** (each made the tests fail, then restored): an email-change confirm that does not end sessions; a closure function without its blocker check (both swapped into `onepos_test` and restored from the migration text); an unmasked dev mail recipient; a personal key dropped from `PERSONAL_KEYS`; the third depth of redaction dropped.
- **Verified this session (final code)**:
  - `pnpm build` 14/14; `pnpm typecheck` 24/24; `pnpm lint` exit 0; `pnpm test --force` 24/24 tasks (observability 15: +3 redaction; config 14: +1; api 52: +1 key rotation; pos-desktop 11: +2 `withReference`);
  - integration, `turbo run test:integration --concurrency=1 --continue --force`: database **33/33**, api **331/331** (new `account-privacy.test.ts` 12; `logging.test.ts` +1), workers **18/20**. The two failures were consecutive tests in `outbox.test.ts` "handlers": the first drained the outbox without ever claiming its own just-emitted welcome event, and the next test's processor, milliseconds later, sent exactly one mail. That fits the event's `available_at` being briefly later than the claim's `now()`, i.e. a database clock step like the one suspected in session 12; not proven. The only worker change this session is the masked dev-mail log line. `pnpm --filter @1pos/workers test:integration` right after: **20/20**. LEFTOVER item updated;
  - OpenAPI regenerated; `pnpm db:migrate` on the dev DB; `mfa-rekey --check` on the dev DB (28 secrets, all on the current key); `support account-disable/enable` on a throwaway dev account (`cli-smoke-…@example.ph`, left in the dev DB) with both audit rows checked, and the refusals (nothing to change: exit 1; no ticket: exit 2);
  - E2E on the rebuilt API (:4320, rate limits off) and admin `next start` (:3320): **`test:e2e:web:account` 21/21** (new; includes the error reference on a second `next start` against a stub API), `test:e2e:web:security` 24/24, `test:e2e:web` 42/42; POS preview (:3330) `test:e2e:pos` 27/27.
  - Not re-run: the restaurant, reports, offline, back-office, onboarding and desktop suites (their paths did not change; the POS change is the error helper the POS suite covers).
- **Not committed**: sessions 12–14 are still uncommitted in the working tree.

## Phase 6 slice 8 — runbooks and privacy pack (session 13)
As built: ADR-0016 "As built — slice 8". Documentation, plus one test. No migration, no API change.
- **Runbooks** `docs/operations/`: new `README.md` (index; each SPEC §16 item → its document), `incident-response.md`, `security-incident.md`, `database-migrations.md`, `rollback-recovery.md`, `payment-reconciliation.md`, `production-access.md`.
- **Privacy pack** `docs/compliance/privacy/` (drafts for the DPO, **not legal advice**): README (controller/processor split, DPO and NPC registration evaluation, gaps, questions), `processing-register.md`, `privacy-notice-draft.md`, `retention-schedule.md`, `breach-procedure.md`, `data-processing-agreement-outline.md`, `data-subject-requests.md`. The personal-data inventory behind them was taken from migrations 0000–0055, and its key claims were spot-checked in the code.
- **New guard** `packages/database/test/unit/migrations.test.ts`. drizzle runs all pending migrations in one transaction and silently skips a file whose journal `when` is not newer than the last applied one. The test checks journal order, one file per entry, and no `CONCURRENTLY`/`VACUUM`. Mutation check: an out-of-order `when` fails it; the journal was restored byte for byte, and it had uncommitted session-12 entries.
- **Defects found**:
  - `monitoring.md` named a non-existent route, `/v1/payments/:id/reconcile` (now `/v1/payment-intents/…`).
  - My first draft of the account-disable SQL called `auth_record_event`, which accepts only `auth.*` actions. The dry-run caught it before the runbook was finished.
- **Privacy gaps found** (LEFTOVER):
  - no purge of sessions (with user agent), reset tokens, invitations, outbox events or till-local sales;
  - no account closure or self-service profile edit;
  - no correction of recorded SC/PWD details;
  - takeaway names never cleared;
  - log redaction covers secrets only;
  - no `MFA_ENCRYPTION_KEY` re-encryption;
  - correlation id not shown on error screens.
- **Verified this session**:
  - every ops SQL block in the new runbooks dry-run on the dev DB inside rolled-back transactions, as `onepos_migrator`: disable an account, end its sessions and write the platform audit row; revoke every session (377 rows, rolled back); suspend a business; the SC/PWD extent query; `platform_migration_head()`;
  - links: all relative links and anchors in `docs/operations/` and `docs/compliance/privacy/` resolve (20 files, 0 problems), and every backticked file path exists;
  - `pnpm --filter @1pos/database test` **16/16** (+4); `pnpm --filter @1pos/database typecheck` ok; `pnpm exec oxlint apps packages` exit 0.
  - Not run: the integration gate and E2E suites (no product code changed).

## Phase 6 slice 6 — onboarding and support (session 12)
As built: ADR-0016 "As built — slice 6". Migrations 0054 (DDL) and 0055 (hand-written), applied to the dev DB. Runbooks `docs/operations/support-access.md` and `docs/operations/tenant-offboarding.md`. (The audit log reader and the MFA resets were pulled forward in session 10.)
- **Support access** (T14 now ●): an owner/admin gives Tilvara support read-only access for a stated purpose, 1–72 hours (cap also a DB check; a grant's terms never change, it can only be ended). Staff are accounts marked by ops (`support staff-add|staff-disable|staff-list`, migrator only, two-step sign-in required). A staff member opens a grant from `/support` and gets a token for that business only. `AuthGuard` re-checks the grant, the staff account and the MFA session on **every request**, refuses every write (`SUPPORT_READ_ONLY`) and writes every request to the business's audit log. Revoking, expiry or disabling the staff account end access at the next request. Admin: Subscription → Support access (use counts, staff names, end now, audit trail); staff banner "Support view of …" with Leave.
- **Data export**: Subscription → Your records → Prepare a copy. The worker writes a ZIP of CSVs from one REPEATABLE READ snapshot: README, manifest, members, and every tenant table except internal queues; no credential hashes. Files go to `DevFileStorage` (`FILE_STORAGE_DIR`; production refuses it until D1). Downloads use 10-minute HMAC links (404 when forged, altered, expired or crossed to another business). Files are deleted after 7 days by the worker's hourly sweep. At most 5 a day, one at a time; FAILED after 3 tries. Every step is audited. It works for a suspended or lapsed business (`@AllowReadOnlyBusiness()`).
- **Trial sample items**: 8 labelled café items ("… (sample)", priced, not stock-tracked, in-store barcodes 200…), offered only to a trial business before its first sale. Removing them archives them; sales keep their lines. Admin: an overview card and a "Sample" tag on products.
- **Worker role**: may now read every exported tenant table, under RLS inside the event's tenant (secret columns excluded); it still writes no table. New rule in CLAUDE.md: a new tenant table needs a worker grant or an export exclusion (the schema guard enforces it).
- **Defects found and fixed during the slice** (all in my own new code, before it was ever committed):
  - two test assertions were wrong: an unsorted expected list, and E2E text checks that missed CSS-uppercased status words;
  - a test type error, found by the gate's typecheck;
  - the E2E's CLI call split its `--reason` argument under `shell: true`.
- **Mutation check**: removing the guard's grant re-check makes "revoking ends access at the next request" fail; restored.
- **Verified this session (final code)**:
  - `pnpm build` 14/14; `pnpm typecheck` 24/24 (after fixing a test type error the gate found); `pnpm exec oxlint apps packages` exit 0;
  - `pnpm test --force` 24/24 tasks: database 12 (+6: ZIP vs bsdtar, CSV, storage), config 13 (+1), api 51 (+3: links, barcodes), admin-web 19, …;
  - `turbo run test:integration --concurrency=1 --continue --force`:
    - database **33** (schema guard: worker reads, slice-6 function grants, `platform_staff`);
    - workers **20** (+3 `data-export.test.ts`);
    - api **317/318**. New `support-onboarding.test.ts` 17/17; isolation +5 routes and 2 tables, 10/10.
    - The one failure: `reliability.test.ts` "records domain events in the same transaction…". Its two outbox events came back in reverse `created_at` order. This change does not touch signup or event emission, and the file passed 3/3 alone right after. It looks like an intermittent ordering problem (LEFTOVER), most likely a VM clock step. The full API re-run (`pnpm --filter @1pos/api test:integration`) then passed **318/318**.
  - OpenAPI regenerated; `pnpm db:migrate` on the dev DB (0054, 0055); dev traceability audit: no violations;
  - E2E on the rebuilt API (:4320, rate limits off), the worker and admin `next start` (:3320):
    - **`test:e2e:web:onboarding` 23/23** (new);
    - `test:e2e:web` 42/42, `web:security` 24/24, `web:backoffice` 43/43 (BFF proxy, session refresh and layout changed).
  - Not re-run: POS, restaurant, offline and desktop suites (no change in their paths; `/me` gained two fields).

## Phase 6 slice 5 — performance (session 11)
As built: ADR-0016 "As built — slice 5". Migration 0053 (index). All numbers are **this machine's**: a 12-thread laptop with Postgres 18 in Docker Desktop, fsync 2–15 ms. They are not a production claim.
- **Load kit**: `pnpm load:seed` and `pnpm load:run`, in their own database `onepos_load` (kept: 20 businesses, 100,000 items, 650 MB). The report covers p50/95/99, stalls (both event loops and the pool queue), a timeline of slow requests, an optional CPU profile, and integrity read from the database.
- **Defects found by the harness and fixed**:
  1. **Every transaction rebuilt drizzle's relational config for the whole schema** (`drizzle(client, { schema })` in `transaction()`, 0.875 ms of CPU each). It was 46% of the API's CPU under load. `bindDatabase()` cuts it to 0.034 ms (a test guards it). One API process went from 18.4 to 28.8 checkouts/s, and its 103 503s (pool waits over 5 s) went to 0.
  2. **Per-item price queries** in quote, checkout, bills, offline re-pricing and the branch menu: one batched `effectivePrices()` query now.
  3. **Unpaged snapshots**: `?pageSize` + `GET /v1/terminal/snapshot/:id/items` (priced as of the same instant; old tills unchanged); the till transport pages by 1,000; index 0053.
  4. **Sync retry storm**: a batch outlived the till's 15 s timeout and was resent while still recording (up to 5 attempts, 28 s). Fixed by `SYNC_BATCH_BUDGET_MS` (8 s) on the server, and the engine now drains partial answers at once.
- **Pilot load** (60 busy registers at 30 sales/min = 30 checkouts/s offered, 6 offline tills, 120 s):

  | | 1 instance | 2 instances |
  |---|---|---|
  | checkouts/s | 29.1 | 30.0 |
  | lookup p95 (target 150 ms) | 247 ms ✗ | **52 ms ✓** |
  | checkout p95 (target 500 ms) | 959 ms ✗ | **397 ms ✓** |
  | checkout p99 (target 1 s) | 2,117 ms ✗ | 1,568 ms ✗ |
  | sync of 50, typical / worst (target 5 s) | 6.6 / 28.3 s ✗ | 4.4 / 5.9 s ✗ |
  | 31-day reports | met | **met** (p95 < 0.5 s) |
  | integrity | ok | **ok** |

  Integrity means every checkout recorded once, no duplicate client transaction, every replay matched, and every till sale recorded. With 2 instances all tills synced on their first attempt.
  - **Sizing for slice 7**: at least 2 API instances.
  - **Still missed with 2 instances**: checkout p99 and the worst sync. The slow requests cluster in 1–2 s windows while both event loops stay below 50 ms, which points at this machine's database or disk. Re-measure on D1 staging (LEFTOVER).
- **Defect in my own test, found by the gate**: `backup.test.ts` restored all of `onepos_test`. That database had grown to 564 MB, so the restore went past 120 s, and its leftover `pg_restore` slowed the next suite. The test now builds its own small source database: 169 s → 15 s.
- **Environment event**: during one gate run Docker Desktop stopped every container (this project's and others'). `pnpm db:up` restarted only this project's services, and the gate was re-run.
- **Verified this session (final code)**:
  - `pnpm build` 14/14, `pnpm typecheck` 24/24, `pnpm lint` exit 0, `pnpm test --force` 24/24 tasks (pos-offline 13: +3 transport paging, +1 drain of partial answers);
  - `turbo run test:integration --concurrency=1 --continue --force` → database **33**, workers 17, api **301** (+ snapshot pages, + sync time budget, isolation +1 route, + `bindDatabase` guard);
  - OpenAPI regenerated; `pnpm db:migrate` on the dev DB (0053);
  - E2E on the rebuilt API (:4320, rate limits off), admin `next start` (:3320) and POS preview (:3330):
    - `test:e2e:web:offline` 14/14;
    - **`test:e2e:desktop` 21/21**: the till rebuilt with the paged transport;
    - `test:e2e:pos` 27/27, `test:e2e:tables` 32/32, `test:e2e:service` 22/22.
  - Not re-run: the other admin suites (no admin change).

## Phase 6 slice 4 — backup and restore (session 11)
As built: ADR-0016 "As built — slice 4"; runbook `docs/operations/backup-restore.md`. Migrations 0051/0052; new cluster role `onepos_backup` (dev cluster upgraded with `infra/docker/postgres/upgrade/2026-10-17-backup-role.sql`).
- **Backups**: `pnpm backup run`. The dump is `pg_dump -Fc` on an exported snapshot, so the manifest's row counts are exactly what the file holds. It streams through age encryption (`age-encryption` 0.3.1, the official TypeScript implementation), so no plaintext reaches the disk. The manifest records SHA-256, migration head, row counts and the catalog posture. Each run writes a `backup_runs` row. Also `backup verify` and `backup keygen`.
- **Drill**: `pnpm drill:restore`:
  1. file check;
  2. decrypt into `pg_restore --single-transaction` in a scratch `onepos_drill_*` database;
  3. verify head, counts, catalog posture and the tenant-isolation rules (now shared with `rls-catalog.test.ts`);
  4. boot the API on the restored database (RTO measured here);
  5. smoke cash sale;
  6. traceability audit;
  7. recorded in the source database.
- **Monitoring**: gauges `onepos_backup_last_success_timestamp_seconds` and `onepos_restore_drill_last_success_timestamp_seconds`; alerts `OneposBackupMissing` (> 26 h) and `OneposRestoreDrillOverdue` (> 35 days), with runbook sections.
- **Measured on this machine** (dev DB: 2.7 MB encrypted, 92 tables, 57,181 rows):
  - backup 1.3–2.0 s;
  - drill 1: RTO **18.2 s** (cold API boot 13.2 s);
  - drill 2: RTO **5.6 s**, total 8.3 s.
  Both drills passed, with the audit clean over 232 businesses. This is not a production figure (D1 staging measures that).
- **Defect in my own test, found by the first run**: it compared live counts to the manifest without allowing for the backup's own `backup_runs` row, which is written after the snapshot. The product was right; the test now allows for that row.
- **Verified this session (final code)**:
  - `pnpm build` 14/14, `pnpm typecheck` 24/24, `pnpm lint` exit 0, `pnpm test` 24/24 tasks (database unit 6, new);
  - `turbo run test:integration --concurrency=1 --continue --force` → database **32** (+8 `backup.test.ts`, +2 schema guard), workers 17, api 299;
  - `pnpm db:migrate` on the dev DB (0051, 0052); `pnpm backup run` and `pnpm drill:restore` twice on the dev DB (both ok).
- `backup.test.ts` proves the checks can fail:
  - the archive holds no DDL or table names in clear;
  - a flipped byte and a truncated file are refused;
  - the wrong key creates nothing;
  - a bit flipped inside the payload leaves an empty database;
  - a restore mutated five ways (RLS off, an extra grant, an extra policy, a dropped trigger, a missing migration) is caught item by item.
- Not run: E2E suites (no UI change); `test:e2e:desktop`.

## Session 10 — leftovers worked through (after the pilot-safety batch below)
The user asked to "proceed all" with LEFTOVER.md. Done in five commits after slice 3 and the pilot-safety batch; what is still open stays in LEFTOVER.md (mostly blocked on D1–D6/reviewers, or larger product features that need decisions: AP/supplier invoices, promotions, UoM/batch/expiry, landed cost, typed OpenAPI responses).

**1. Admin back office** (`56d281b`):
- purchasing: supplier page (edit, archive), draft order editing, return to supplier from a goods receipt and its return page (receipts now carry `returnedQuantity` and their returns), a list of returns;
- journal filters (dates, source type) and a document link for every entry: new **sale page** (lines, returns, voids), **shift page** (float, pay-ins/outs, count, sales), return and pay-in redirects;
- team: member access editor, custom roles (create/edit/archive) with every permission worded in EN/FIL (unit test: each permission in one group, worded in both languages);
- products: edit product, variants, barcodes; price lists: create, rename, make default, use at a branch;
- legal entity page with the tax registration history and scheduled changes;
- all reorder points (new `GET /v1/stock/reorder-points`); restaurant renames (stations, areas, tables and seats) and choice group bounds; recipe ingredient units;
- no first-200 limit any more: pickers page through all products; documents name lines through new `GET /v1/variants?ids=`;
- new API routes `GET /v1/sale-returns/:id`, `/v1/cash-movements/:id`; members carry `roleId`, roles `archivedAt`, price lists `branchIds`, products `barcodeIds`.

**2. Reports** (`ee7d840`): the Sales group on `/reports` (summary, by product, cashier, tender, tax summary, SC/PWD book; the Reports tab opens there), quick ranges (week from Monday, months, semi-monthly pay periods; `datePresets` unit-tested), **CSV download for every report** (exact decimal strings, UTF-8 BOM, formula-safe fields; `report-csv` unit-tested).

**3. Built-in Restaurant Manager and Kitchen Crew roles** (`94e712c`), back-filled by migration 0049 into every business. **Defect found and fixed:** the first 0049 read `tenants` under FORCE RLS and inserted nothing (209 dev businesses, 0 roles); the fix lifts RLS on `tenants` for the back-fill too; dev DB re-applied (209/209). CLAUDE.md's back-fill rule now says "every table it reads".

**4. POS and kitchen display** (`de48db9`): F2/F4/F8/F9 shortcuts; a phone pay bar that steps aside when the payment panel is on screen; shift history tags (tender, voided, items returned; `GET /v1/sales` carries them); KDS chime + flash for new tickets and a Done view; seats in the composer and on tickets; move items / merge orders; split a check by seat (bill lines carry `seat`); print and reprint the bill.

**5. Support and exports** (this commit): MFA reset by an owner/admin and by support for owners (migration 0050, ADR-0016 "ahead of slice 6", runbook `docs/operations/support-mfa-reset.md`, `pnpm --filter @1pos/database support mfa-reset`); audit log reader `GET /v1/audit-logs` and admin `/audit`; journal lines export `GET /v1/journal-lines` (≤ 366 days, 50,000 lines) and a journal CSV download; return/void slips `GET /v1/sale-returns/:id/receipt`, shown and printable in the POS shift history. **Defect found by the test and fixed:** the slip first printed the stored 4-decimal amounts (₱16.5000).

**Verified this session (final code, servers rebuilt: API :4320 with rate limits off, admin `next start` :3320, POS preview :3330):**
- `pnpm build` 14/14, `pnpm typecheck` 24/24, `pnpm lint` exit 0, `pnpm test` 24/24 tasks (admin-web 19, pos-desktop 9, validation 7, api 48, …);
- `turbo run test:integration --concurrency=1 --continue --force` → database **22**, workers **17**, api **299**;
- E2E: `test:e2e:web:backoffice` **43/43** (new), `web` 42/42, `web:security` 24/24, `web:reports` 19/19, `web:restaurant` 22/22, `web:offline` 14/14, `pos` **27/27**, `pos:mfa` 5/5, `tables` **32/32**, `kitchen` **17/17**, `service` 22/22;
- `pnpm db:migrate` on the dev DB (0048–0050); OpenAPI regenerated.
- Not re-run: `test:e2e:desktop` (the till shares the POS front end that the browser suites cover; its shell did not change).

## Pilot-safety leftovers (session 10)
From `docs/LEFTOVER.md`, picked by the user. Migration **0048** (hand-written).
- **New recovery codes** (Phase 6 slice 1 gap): `POST /v1/auth/mfa/recovery-codes` `{password, code}` → ten new codes shown once; every old code stops working. Needs the password and a current TOTP code (a recovery code cannot mint new ones; the step is spent). The work happens in `auth_mfa_regenerate_recovery()` (SECURITY DEFINER, `onepos_platform`), which writes a NULL-tenant audit row `auth.mfa.recovery_codes_regenerated`. Admin `/security`: when MFA is on, one form with "New recovery codes" (and "Turn off" only when the role allows), EN/FIL.
- **DB guard for `PAYMENTS_OUTSTANDING`** (Phase 2 leftover): trigger on `cashier_sessions` refuses leaving OPEN while a card/QR intent is PROCESSING, UNKNOWN or SUCCEEDED in no sale (constraint `payments_outstanding` → 409 `PAYMENTS_OUTSTANDING` in `TenantService.mutate`). New `payment_intents` insert trigger requires an OPEN session with `FOR SHARE`, so a racing close waits for the insert and then sees it.
- **`POST /v1/stock/adjustments` requires an Idempotency-Key** (Phase 3 leftover), like every other stock document. No UI creates adjustments; 29 test call sites and 3 POS E2E fixtures now send one.
- **Receipt SC/PWD block** (Phase 2 leftover): the block no longer repeats the discount when there is one beneficiary (the "SC/PWD discount" total already shows it). With several beneficiaries each block shows its share, with a minus like the totals. Screen and thermal print alike.
- Rate-limit fallbacks and Redis health as metrics: already delivered by slice 3 (`onepos_rate_limit_fallbacks_total`, `onepos_redis_up`).
- **Tests (run this session, final code)**:
  - `pnpm build` 14/14, `pnpm typecheck` 24/24, `pnpm lint` exit 0, `pnpm test --force` 24/24 tasks (POS 8: +1 split-beneficiary receipt, and the single-beneficiary receipt asserts the discount prints once);
  - integration, full gate `turbo run test:integration --concurrency=1 --continue --force` → database 22, workers 17, api **294**. New tests: `account-security` "new recovery codes"; `failure-drills` "the database itself refuses…" (runtime role: close refused while UNKNOWN and while SUCCEEDED-unused, allowed after cancel; insert on a closed shift refused); `sales` "keyless adjustment → 400 `IDEMPOTENCY_KEY_REQUIRED`";
  - OpenAPI regenerated (new route; adjustment key now `required`); `pnpm db:migrate` on the dev DB (0048);
  - E2E on the rebuilt API (:4320, rate limits off), admin `next start` (:3320) and POS preview (:3330):
    - `test:e2e:web:security` **24/24** (+3: offered new codes and no "Turn off" for the owner, ten new codes none old, ten left). The first run was 22/24: "a wrong password is refused in words" and "forgot password answers the same" failed, both outside this change. The immediate re-run passed 24/24. Not traced; likely cold-start timing on the fresh server.
    - `test:e2e:web` 42/42, `test:e2e:pos` 19/19, `test:e2e:tables` 25/25, `test:e2e:service` 22/22.
  - Not re-run: `test:e2e:desktop`, `pos:mfa`, `web:restaurant`, `web:reports`, `web:offline`, `kitchen`.

## Phase 6 slice 3 — monitoring (session 10)
As built: ADR-0016 "As built — slice 3" (registry, internal metrics ports, SPEC §16 instruments, `platform_metrics()` business gauges, readiness with migration head + Redis, worker heartbeat, DEAD-letter CLI, 25 alert rules with runbook links in `docs/operations/monitoring.md`). Migrations 0046/0047.
- **Verified this session (final code)**:
  - `pnpm build` 14/14, `pnpm typecheck` 24/24, `pnpm lint` exit 0;
  - `pnpm test --force` 24/24 tasks (observability 12, config 12, workers 3, api 47, …);
  - `turbo run test:integration --concurrency=1 --continue --force` → database **22**, workers **17**, api **292** (all green);
  - `pnpm db:migrate` on the dev DB (0046, 0047 applied);
  - live boot (`pnpm --filter @1pos/api start`, `pnpm --filter @1pos/workers start`): `/v1/health/ready` → `{status: ok, checks: {database, migrations, redis: up}}`; `:4329/metrics` shows `onepos_db_up 1`, `onepos_redis_up 1`, `onepos_schema_migrations_behind 0`, outbox 24 PENDING → worker delivered them (`onepos_worker_outbox_events_total{outcome="done"} 24`), then `onepos_workers_alive 1`, heartbeat age 9 s; `/metrics` on the public port 404; `dead-letters list` → 0.
  - Not re-run: E2E suites (no UI change in this slice).
- Note: `pnpm dev:api` does not load `.env` (nest watch); use `pnpm --filter @1pos/api start` after a build, or export the env first.

## Phase 6 slice 2 — platform hardening (session 9)
- **Rate limits shared through Redis** (ADR-0016 "As built — slice 2"):
  - an atomic Lua counter;
  - if Redis is unreachable each hit is counted in the instance instead: still limited, sign-in still works, a `fallbacks` counter, a warning at most once a minute;
  - rules per IP, per account (hashed email) or per terminal, several per route:
    - login: per IP + per account;
    - password reset: per IP + per account;
    - sync: per terminal + per IP;
  - `TRUST_PROXY_HOPS` setting;
  - production requires `REDIS_URL`.
  - **Defect found by the first test run and fixed**: in the first moments after boot, ioredis had not connected yet, so hits were split between memory and Redis and no limit was reached. Boot now waits up to 2.5 s for the connection.
- **`onepos_worker` DB role** (migration 0045):
  - only this role can run the outbox and the idempotency purge; both are revoked from the API role;
  - read-only, column-level, under RLS: `tenants`, `tenant_memberships`, `users` (no secrets);
  - it writes no table directly;
  - the worker uses `WORKER_DATABASE_URL`, required in production.
  - The dev cluster was upgraded with `infra/docker/postgres/upgrade/2026-10-17-worker-role.sql`, and `.env` gained `WORKER_DATABASE_URL` / `TEST_WORKER_DATABASE_URL`.
  - The real worker booted against the dev DB as `onepos_worker` and delivered the queued welcome mails.
- **Dependencies**: `pnpm security:audit` found 7 advisories in Next.js 16.3.5 (critical RCE in `next/og`, high SSRF in image optimization, 4 moderate, 1 low). Upgraded to **16.3.8**: 0 left in production dependencies. One dev-only moderate advisory accepted (esbuild in drizzle-kit).
- **Bundle secret scan**: `pnpm security:bundles` (self-test with planted leaks, then the admin static and POS bundles): 38 files, 0 findings.
- **Security pass**: THREAT_MODEL "Control → test map". Gaps are named: webhooks, support access, exports/backups, load, CI automation, nonce CSP, refund approval thresholds.
- **Tests (run this session, final code)**:
  - `rate-limit.test.ts` **6** (two replicas share one allowance; per-account reset and login caps; per-terminal + per-IP sync caps; Redis down);
  - workers **11** (+3 role tests);
  - database **22** (worker posture in the schema guard);
  - config 11;
  - full gate `turbo run test:integration --concurrency=1 --continue` → database 22, workers 11, api **279** (all green);
  - `pnpm typecheck` 24/24, `pnpm lint` clean, `pnpm test` 24/24 tasks, OpenAPI regenerated;
  - E2E on the rebuilt API (:4321), admin `next start` on Next 16.3.8 (:3322) and POS preview (:3331):
    - `test:e2e:web` 42/42, `web:security` 21/21, `web:offline` 14/14;
    - `test:e2e:pos` 19/19, `pos:mfa` 5/5.
  - Not re-run: `test:e2e:desktop`, restaurant/reports/tables/kitchen/service suites.

## Phase 6 slice 1 — account security (session 9)
- **Two-step sign-in (TOTP)**, as built in ADR-0016:
  - **Who needs it**: privileged members. A member is privileged when they hold any of the `PRIVILEGED_PERMISSIONS`. Built-in roles: owner, admin, accountant.
  - **When**: required after `MFA_GRACE_DAYS` (7). Until then the admin shows a banner with the date.
  - **When it applies**:
    - Once due, business routes answer `403 MFA_REQUIRED` and the admin redirects to `/security`.
    - A session that started before enrolment must sign in again.
  - **How codes work**:
    - Each time step is accepted once; recovery codes are shown once.
    - Wrong codes count towards the password lock.
    - Secrets are encrypted at rest (`MFA_ENCRYPTION_KEY`, required in production).
- **Password reset**: one-time link (30 min, only the newest works, at most 5 per hour). The answer is the same for unknown emails. A reset revokes every session and keeps MFA on. Mail goes through `Mailer`, which is DevMailer until the email provider is chosen (D2).
- **Audit**:
  - lockout, refresh reuse, MFA and reset are recorded at platform level (NULL tenant);
  - sign-out, switching business and login `{mfa}` are recorded in the tenant.
- **Headers**:
  - API: helmet now in `configureApp`, so tests see it; CSP `default-src 'none'`; HSTS.
  - Admin: CSP (self only, no framing), HSTS outside dev, Permissions-Policy.
  - `API_HOST` setting for containers.
- **Admin screens**:
  - sign-in code step (the challenge is held in an httpOnly cookie);
  - `/forgot-password`, `/reset-password`;
  - `/security` (QR code via `uqr`, set-up key, recovery codes, turn off).
  - **POS**: code step at sign-in.
- **Migrations** 0043 (DDL) and 0044 (hand-written: RLS posture, the `auth_*` functions); applied to the dev DB.
- **Defect found by the screenshots and fixed**: the 1440px band clipped the last tab. It was already 4px over before this slice and got worse with the new account link. Fixed with `lg:gap-0`; the E2E now asserts the nav does not overflow (that check was confirmed to fail on the old build).
- **Gaps (BACKLOG)**:
  - no way to regenerate recovery codes;
  - no support reset of a member's MFA (needed before the pilot);
  - no nonce CSP;
  - no passkeys;
  - no per-account rate limit.
- **Tests (run this session)**:
  - unit: `totp.test.ts` 9 (RFC vectors, window, base32, otpauth URI, recovery codes, AES-GCM tamper); config 9; API unit 44;
  - integration: `account-security.test.ts` **19** with `auth.test.ts` 17 (36/36); database 21 (schema guard extended to the credential tables);
  - E2E against a fresh API (:4321), admin `next start` (:3322) and POS preview (:3331):
    - `test:e2e:web:security` **21/21**;
    - `test:e2e:web` 42/42;
    - `test:e2e:pos:mfa` **5/5**;
    - `test:e2e:pos` 19/19;
  - `pnpm build` 14/14, `pnpm typecheck` 24/24, `pnpm lint` clean, OpenAPI regenerated;
  - full gate: `turbo run test:integration --concurrency=1 --continue` → database 21/21, workers 8/8, api **273/273**. `vitest list` collects exactly 273, so nothing was skipped. 273 − 19 new = 254 tests from before this session, not the 257 session 8 recorded; the difference was not traced.
  - **Not run this session**: `test:e2e:desktop` (the till's sign-in screen changed; only typechecked and covered by the browser-mode `test:e2e:pos:mfa`), and the restaurant/reports/offline/service/tables/kitchen E2E suites (no change in their paths).

## Phase 5 — Offline & integrations
**Exit criterion met for offline cash sales (2026-10-17, session 8)**, with two items deferred by the user's decision ("continue without PayMongo"):
- payment integration hardening (PayMongo; waits for sandbox keys);
- invoice transmission (compliance gate).

Plan and exit review: `docs/decisions/ADR-0015-offline-sync.md` ("Exit review"). The starred policies are defaults the user may revisit: cash-only offline on a shift opened online, stale prices flagged not refused, local receipt reference until sync, stock may go below what the cloud knows. PayMongo slots in whenever the keys arrive.

## Phase 5 exit review (session 8)
- **SPEC §11 traced** requirement by requirement (ADR-0015 table). The one gap, monitoring delayed or failed sync, was built:
  - `GET /v1/sync/terminals` (till health for `cash.reconcile`: last contact, waiting sales, open shift, **silent** = open shift and over 30 min without contact);
  - an admin "Tills" panel on `/offline-sales`;
  - flags shown in words on recorded sales.
- **Drills added** (`offline-engine.test.ts` "exit review drills"):
  - two tills, one register, simultaneous sync → gapless 1–8;
  - shift close racing a sync, 4 rounds → both orders observed, never a sale on a closed shift;
  - a till restored from an old backup → replays + new sale, nothing twice.
- **Defects fixed**:
  - the till fetched a full snapshot every 30 s online (≈2,900 rows/day/till) → every 10 min online, every 30 s only offline;
  - offline flags were stored but invisible;
  - a till's wrong clock was shown as "Rung up" → the recorded time is shown, and the flag says what the till said.
- **Runbook**: `docs/operations/offline-terminal-recovery.md`.
- **Not drilled**: `PERIOD_CLOSED` for an offline sale (needs month-old fixtures; covered by the ledger guard and the generic quarantine path).
- **Tests (run this session, final code)**:
  - unit: `pnpm test` 24/24 tasks; `cargo test` 8/8;
  - integration: `turbo run test:integration --concurrency=1 --continue` → database 21, workers 8, api **257**;
  - E2E, all nine suites against a fresh build (API :4321, POS :3331, admin :3322):
    - admin smoke 42/42, restaurant 22/22, reports 19/19, **offline review 14/14** (re-run after the flag fix);
    - POS 19/19, tables 25/25, kitchen 13/13, service 22/22;
    - **desktop 21/21** (re-run after the snapshot-rate change);
  - dev DB traceability audit (`test/dev-audit.ts`): 166 tenants, 171 sales, 472 movements, 305 entries, **no violations**.

## Phase 5 slice 5 — the desktop till (session 8)
- **Toolchain**: Rust 1.99.1 (rustup, stable MSVC) and the VS 2022 Build Tools C++ workload installed with the user's approval. WebView2 was already present. cargo is in `%USERPROFILE%\.cargo\bin`; new shells may need it added to PATH.
- **Shell** `apps/pos-desktop/src-tauri` (Tauri 2), ADR-0015 "As built (slices 4–5)":
  - `store`: a single `rusqlite` connection, not the SQL plugin, whose pool would break `transaction()`. WAL + FULL; a new page rolls back what a dead page left open.
  - `printer`: TCP/9100 or Windows RAW spooler, with a deadline.
  - `secrets`: terminal credential in Windows Credential Manager.
  - Ten commands, each granted in `capabilities/default.json`; CSP; `ONEPOS_TILL_PROFILE` for isolated test runs.
- **POS**:
  - set-up screen, band status chip + till settings (printer, send now, disconnect), outage banner;
  - offline cash selling in `Sell` (snapshot lookup and pricing, no SC/PWD or card/QR offline);
  - the offline receipt with the printed TIN (`legalEntity.receiptTin` added to the snapshot);
  - thermal printing for every receipt when a printer is set.
  - A lost checkout answer followed by an offline recording uses the same transaction id → never counted twice (quarantined as `DUPLICATE_TRANSACTION`). The admin `/offline-sales` screen words it: "Already recorded online as sale #000002 … Dismiss this copy". Typechecked only; `test:e2e:web:offline` was not re-run.
- **Defects found by the E2E and fixed**:
  - `freezePrototype` blanked the app (a library assigns `toString`);
  - a reload mid-transaction left the till's connection inside it, so the till never loaded (now rolled back on page start);
  - SC/PWD buttons and a "take card/QR" hint were still shown offline.
  - Test-harness traps found on the way:
    - Chromium silently re-sends a POST whose connection closed before any reply byte (the API's idempotency replayed it), so the lost-answer drill cuts after the reply starts;
    - WebView2 starts on about:blank, and reloading it during start-up can leave a blank page.
- **Server address at set-up** (after the slice 5 commit): a field on the set-up screen, checked by fetching a snapshot and saved in the till. It must be `https://`, or `http://` to this computer only. `normalizeApiUrl` has unit tests. `test:e2e:desktop` is now **21/21** (twice), adding the refusal of a LAN `http://` address. A plain build is used, and the script types the proxy address at set-up.
- **Also this session**:
  - PayMongo env settings (format-checked, live keys refused outside production; `PAYMENT_PROVIDER` stays `dev` until the adapter exists);
  - `SNAPSHOT_EXPIRED` integration test (23 h clean / 25 h flagged).
- **Tests (run this session)**:
  - `cargo test` 8/8 (in `apps/pos-desktop/src-tauri`);
  - `@1pos/pos-offline` 9/9; `@1pos/config` 8/8; API unit 35/35; offline integration (`offline-sync` 5 + `offline-engine` 4) 9/9;
  - `test:e2e:desktop` **20/20**, run twice in a row after the last change (4 consecutive passes on the version before the TIN/SC fixes);
  - browser-mode regression: `test:e2e:pos` 19/19, `test:e2e:tables` 25/25;
  - `pnpm build`, `pnpm typecheck`, `pnpm lint` clean;
  - gate at commit: `turbo run test:integration --concurrency=1 --continue` → database 21/21, workers 8/8, api 253/253.
- **Test fragility fixed**: two offline price-change tests stamped device times with the host clock, milliseconds away from a price change stamped by the DB clock. After a Docker restart the two clocks differed by ~130 ms and the tests flipped (once one way, once the other). Both now date those sales from the DB clock.

## Phase 5 slices 3–4 — printing and the review screen (session 7)
- **`@1pos/escpos`** (new, pure): a neutral `PrintableReceipt` → fixed-width layout (32/42/48 columns; long names wrap with the amount on the last line) and ESC/POS bytes:
  - init and the CP437 code page (`₱` printed as `PHP`, `ñ` kept, unknown characters as `?`);
  - centred header, bold notice, double-height TOTAL DUE;
  - the SC/PWD block with a signature line;
  - partial cut, and an optional drawer kick.
- **POS**:
  - `lib/printing.ts` turns the server receipt and the offline receipt into that model (receipt labels moved there, shared with the screen);
  - `escposPrinter` / `escposDrawer` on a byte channel, with a timeout;
  - the receipt's Print button reports a printer failure ("The sale is recorded; check the printer and print again") and offers "Print again". The SPEC lists printer failure among the failures to handle; printing is never part of the sale.
- **Admin `/offline-sales`** (nav "Offline", for `cash.reconcile`; the BFF allows `sync/transactions` only, never the terminal routes):
  - tabs: to review / recorded / dismissed;
  - each problem worded in EN/FIL (e.g. "The till charged a different total than its price list gives (₱20.00 vs ₱22.40)");
  - "Record again" (a refused attempt is counted, and the row refreshes even on refusal); dismiss with a reason;
  - stacked rows on phones.
  - The API list now carries the cashier's name, register code and sale number.
- **Found by the screenshots and fixed**:
  - adding a twelfth nav item pushed "Subscription" off the bar at 1440 px; the label is now "Offline";
  - a sale naming an unknown person showed "—" as cashier; it now reads "Unknown cashier".
- **Tests**:
  - escpos 5 and POS printing 4 (unit);
  - `test:e2e:web:offline` **12/12**;
  - every other E2E suite re-run on the new build: admin smoke 42/42, restaurant 22/22, reports 19/19, POS 19/19, tables 25/25, kitchen 13/13, service 22/22 (174 checks in all; reported by the building session, not re-run at commit time);
  - gate at commit (2026-10-17): `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0; `turbo run test:integration --concurrency=1 --continue` → database 21/21, workers 8/8, api 252/252.
  - Note: two integration runs against `onepos_test` at once make `outbox.test.ts` flaky (processors claim across tenants) — run one at a time.

## Phase 5 slices 1–2 — offline sync (session 7)
- **Server** (migrations 0041/0042, both with forced RLS):
  - `terminal_snapshots` (append-only) and `terminal_transactions` (moves only QUARANTINED → RECORDED/DISMISSED; dismiss needs a person and a reason; never deleted);
  - offline columns on `sales`: origin, terminal, local reference, flags (a check ties them together);
  - `auth_terminal()` is SECURITY DEFINER, owned by `onepos_platform`; the app role still cannot read credential hashes.
- **Routes**:
  - `GET /v1/terminal/snapshot`: priced items as of the DB clock, the tax profile, the register's open shift;
  - `POST /v1/sync/sales`: up to 50 envelopes, each in its own transaction, in device order;
  - `GET /v1/sync/transactions[/:id]`, `POST …/:id/retry`, `POST …/:id/dismiss` (`cash.reconcile` at the register's branch);
  - shift close refused while offline sales are quarantined (`OFFLINE_SALES_UNRESOLVED`).
- **Recording**: `SalesService.recordOffline` runs as the shift's cashier (grants loaded at sync):
  - re-prices through `computeCart(…, asOf = snapshot)` and records through the shared `record()`;
  - `completed_at` = device time clamped to [shift opened, now]; the journal entry is dated on the branch's day;
  - the delivery row commits with the sale;
  - flags: `PRICE_CHANGED`, `SNAPSHOT_EXPIRED` (`OFFLINE_WINDOW_HOURS`, default 24), `CLOCK_ADJUSTED` (only beyond 5 min of drift).
- **Defects found by the first test run and fixed before commit**:
  - the snapshot instant included the 5 s "in force" skew, so a price set seconds after the snapshot counted at re-pricing (→ `TOTAL_MISMATCH`); the snapshot now uses the plain DB clock;
  - sub-second host/DB clock drift flagged every sale `CLOCK_ADJUSTED`; the clamp stays, the flag needs > 5 min.
- **Client**: `@1pos/sync-protocol` (schemas, `canonicalJson`) and `@1pos/pos-offline`:
  - `LocalStore` over a `SqlDriver` (`node:sqlite` now; the Tauri SQL plugin later; WAL + synchronous=FULL);
  - `OfflineEngine`:
    - `ringUp` prices with `@1pos/tax` from the snapshot and writes sale, envelope and device number in one local transaction;
    - `syncOnce` / `drain` send in device order;
    - no answer, 5xx or 429 → backoff 1 s → 5 min with jitter, same envelopes;
    - 401 → stop selling and syncing;
  - `httpTransport`.
- **Tests**:
  - `offline-sync.test.ts` (4): terminal auth + snapshot, sync order/dedupe/replay/reused id/wrong register, flags, quarantine → close blocked → retry recorded → dismiss → variance;
  - `@1pos/pos-offline` unit (7);
  - `offline-engine.test.ts` (4), drills of the real engine over HTTP:
    - an outage with a restart → 3 sales recorded once, in order, at device times;
    - lost answers, then a DB-down API (503), then normal → replayed, never doubled;
    - 120 sales in batches 50/50/20;
    - a price rise flagged; a shift closed elsewhere → quarantine; a revoked till stops.
- **Isolation**: +3 id routes, a terminal cross-tenant case (B's snapshot/shift named by A's terminal → quarantined `UNKNOWN_SNAPSHOT`, nothing in B), both tables in the sweep.

### Verified — Phase 5 slices 1–2 (commands actually run)
| Command | Result |
|---|---|
| `pnpm build` (13/13) · `pnpm typecheck` (22/22) · `pnpm exec oxlint apps packages` (exit 0) · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **130 passed** (+ sync-protocol 2, pos-offline 7) |
| `pnpm test:integration` | **281 passed**: database 21, api **252** (+ offline-sync 4, offline-engine 4, isolation 10), workers 8 |
| `pnpm db:migrate` (dev) | 0041, 0042 applied |

**Phase 4 — Restaurant: exit criterion met** (session 7). A restaurant completes a full service cycle and reconciles stock, payments and books, through the real screens and under concurrency. Plan and as-built notes: `docs/decisions/ADR-0014-restaurant-orders.md` ("Exit review"). Still open outside the code: the tax adviser's and accountant's answers on the service charge (base, VAT, SC/PWD share, liability). **Next: Phase 5** (see "Next task").

## Phase 4 exit review (session 7)
**1. SPEC restaurant scenarios 1–10, end to end.** New `pnpm test:e2e:service` (`apps/pos-desktop/e2e/service.mjs`) runs one service in one tenant across three browsers (admin, floor, KDS), **22/22**:
1. admin: menu published (Mains → Burger with Doneness + Extras at GRILL, Drinks → Iced tea at BAR), recipe 1 bun + 0.15 kg beef, 10 % service charge;
2. floor opens T1 for 2;
3. 2× burger (Medium · Cheese) + 2× tea, ₱430.00 priced by the server;
4. KDS: the grill sees the burgers, not the tea;
5. start → bump at the grill and the bar; the floor sees Ready by polling and serves; the board empties;
6. bill ₱473.00 with the charge line; split evenly ₱236.50;
7. cash (change ₱13.50, receipt) + card; settled; T1 free;
8. stock bun 48, beef 4.7 kg, cheese 38; ingredient usage expected = actual;
9. item performance, service charge ₱43.00 / ₱38.39 = books, trial balance balances, GL Sales 383.93 Cr / charge payable 38.39 Cr / output VAT 50.68 Cr / COGS 136.00 / cash 236.50 / card clearing 236.50;
10. close: expected ₱1,236.50, drawer balanced, shift RECONCILED.

**2. Drills.** New `restaurant-drills.test.ts` (9), two tills (R1/R2, two cashiers), each ending with the audit:
- halves paid at two tills at once → both recorded, the later settles, Σ = ₱473.00, bases = 383.93, each drawer ₱1,236.50;
- three thirds from one preview (₱157.66) at once → two recorded, the one that turns out last refused `TOTAL_CHANGED` with ₱157.68, re-previewed and paid;
- the same tea at both tills → once (`ALLOCATION_EXCEEDS_LINE`); "pay the rest" by cash at R1 and an authorized card at R2 → one; the losing card blocks R2's close (`PAYMENTS_OUTSTANDING`) until cancelled;
- double-tapped check (same key ×5) → one sale; reopen vs first check → one wins with a state code;
- two tablets: fire while adding and editing → nothing lost, every item on exactly one ticket; add while the bill prints → `ORDER_HAS_PENDING_ITEMS` or `ORDER_NOT_OPEN`, and the bill = the live items;
- void vs printing the bill on four tables → the bill leaves the tea out (₱374.00) or the void is refused;
- two managers voiding a cooking burger while the kitchen marks it ready and bumps → one void, one WASTE document (1 bun, 1 cheese);
- connection killed while a check waits on the bill lock → 503, nothing written (sales, lines, charges, allocations, cash, stock, numbers, entries, keys), bill still ACTIVE; the same key then pays once; replay answers the same sale.
No product defect surfaced; the lock order (session → bill → order) held. Stable over 4 consecutive runs.

**3. Audit.** `traceability-audit.ts` gained three restaurant rules (Σ checks = settled bill; no line paid beyond the whole, no check on a voided/foreign bill; order state follows its bill), mutation-checked (an order forged to SETTLED is reported). New `apps/api/test/dev-audit.ts` runs it over a whole DB: **dev DB: 98 tenants, 41 migrations (0000–0040, nothing to migrate), 68 sales, 21 bills, 206 movements, 123 entries — no violations**; 39 documents predate the ledger (29 sales, 7 returns, 3 variances — the same set accepted in Phase 3).

**4. Design finish review** (impeccable-finish-reviewer, 8 material fixes, all applied):
- **Defect: a check's receipt did not add up.** The service charge printed ex VAT (₱19.19) beside VAT-inclusive items, so Gross ₱234.19 ≠ TOTAL DUE ₱236.50. It now prints with its VAT (₱21.50 V) and the receipt's Gross is the sum of the printed lines (`receipt.ts`; unit test + `bills.test.ts`). The stored `sales.gross` is unchanged (BACKLOG).
- Ingredient names on recipes and item names on the sold-out list were empty for single-variant products → product name; recipe lines show units (0.15 KG, 1 PC).
- One word for a printed, unpaid bill: "To pay" / "Babayaran" on the floor, order and bill (was "Billed" and "Waiting for payment").
- KDS: a fired, unstarted item reads "New" / "Bago" (was the floor's "Sent").
- Published menu: the publish date sits below the title, not above the content.
- Service charge phone rows label the check count; ingredient usage shows units on every column.
DESIGN.md records the state-word rule.

## Verified in session 7 (commands actually run)
| Command | Result |
|---|---|
| `vitest run … restaurant-drills.test.ts` ×4 | 8/8 each (9/9 after the audit mutation case was added, with `traceability.test.ts`: 11/11) |
| `pnpm test:integration` (before the review fixes) | **272 passed**: database 21, api **243**, workers 8 |
| `pnpm --filter @1pos/api exec tsx test/dev-audit.ts` (dev DB, as `onepos_owner`) | no violations, 39 pre-ledger (twice: before and after the restaurant rules) |
| `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` (exit 0) · `pnpm build` · receipt unit tests (6) | ok |
| All seven E2E suites against the rebuilt API (:4321), admin `next start` (:3321) and POS preview (:3330) | `test:e2e:pos` 19/19 · `tables` 25/25 · `kitchen` 13/13 · `web` 42/42 · `web:restaurant` 22/22 · `web:reports` 19/19 · **`service` 22/22** (162 checks) |
| `pnpm test` + `pnpm test:integration` after the fixes | unit **121 passed** (api 35, tax 30, money 15, accounting 14, admin-web 9, config 6, validation 5, observability 5, workers 2) · integration **272 passed** (database 21, api 243, workers 8) |
The services on :4321/:3321/:3330 (started in session 6) were stopped and restarted on the new build; the stale :4320/:3320 processes were left alone.

## Phase 4 slice 6d — report screens (session 6)
- **Admin `/reports`** (nav item for `reports.read`, so branch managers see it): branch picker plus a plain GET date form (`?branch&from&to`, or `?day` for open orders), so a report can be bookmarked. Six tabs over the slice-5 API, all server-rendered, EN/FIL, stacked rows on phones:
  - **item performance** (blue): each dish with its priced choices indented under it, a "with choices" subtotal, quantity / net sales / revenue ex VAT / cost / gross profit / margin, totals;
  - **ingredient usage** (gold): cost figures plus per ingredient expected / thrown away / count variance / actual (with units) and the over-use signed and in %;
  - **kitchen voids**: figures, each void with the stage reached, reason and person, and its waste value linked to the stock document; by reason and by person;
  - **prep times**: per station, timed/items, average/median/"9 in 10 within"/longest, wait and pass (`duration()` m:ss, unit-tested), all-stations foot;
  - **open orders**: as of the close of a day; open vs billed, not served, left to collect;
  - **service charge** (ink): per day, base / charged / given back / VAT / net ex VAT; "to distribute"; the ledger cross-check (an error callout if it ever differs); the RA 11360 caveat that before or after VAT awaits the accountant.
- A range the API refuses shows the rule from the API's issues (e.g. `"from" must not be after "to"`), not a crash.
- **E2E** `pnpm test:e2e:web:reports` (new) **19/19**, first run. The service day is arranged through the API with the shared restaurant fixture, then each report is read in the admin:
  - burger ₱300.00, its cheese ₱40.00 under it, "with choices" ₱340.00, tea, total ₱430.00, burger cost ₱6.00;
  - cheese expected 4, thrown away 1, actual 5, +1 (25.0%), +₱3.00;
  - the dropped burger (cooking, ₱3.00, linked);
  - Grill 1/2 timed, Bar 1/1, all 2/3;
  - T2 open, T1 not listed;
  - ₱43.00 charged, ₱38.39 to distribute, equal to the books, caveat shown;
  - reversed range refused; 6 pages without sideways scroll at 390px; Filipino.

## Phase 4 slice 6c — admin restaurant set-up (session 6)
- **Admin `/restaurant`** (nav item for `restaurant.manage`; BFF allow-list + kitchen-stations, dining-areas, restaurant-tables, modifier-groups, modifier-options, menus, menu-versions), five tabs, EN/FIL:
  - **Floor & kitchen** (per branch, violet): stations (add with code/default, make default, archive), areas with table tiles (add, seats, archive; empty areas archivable);
  - **Choices** (blue): groups with their rule in words, options free or priced by an item, add group (option lines), add/archive option (refused below the minimum, so hidden then);
  - **Menus** (blue): list (published version, draft, served by); menu page with the draft editor (sections and items in order, display name, kitchen station from the branches' codes, choices offered, move up/down, remove, save → publish with confirmation, refused while unsaved), the published version read-only, version history, start a new draft, archive when no branch serves it;
  - **Recipes** (gold): dishes (items not tracking stock); per dish the versions (in force / scheduled / superseded with ingredients) and a new-version form (stocked ingredients per portion, optional future start, note);
  - **Branch settings** (per branch): dine-in/takeaway menus (published only), service charge % (string-exact `rateFromPercent`/`percentFromRate`, unit-tested), dine-in/takeaway, VAT treatment with a seller-aware hint; sold-out list with "back on", marking only items this branch's menus offer.
- **E2E** `pnpm test:e2e:web:restaurant` (new) **22/22**:
  - station, area and tables;
  - the Doneness group (required, pick 1);
  - menu draft → save → publish (frozen, no draft left);
  - recipe in force (1 bun + 0.15 kg beef);
  - settings saved: server rate `0.1`, shown back as 10;
  - burger sold out with a note;
  - **the POS branch menu shows Mains → Burger with Doneness, GRILL, sold out**;
  - back on, table archived, 4 pages without sideways scroll at 390px, Filipino.
  The admin smoke still passes, **42/42**.
- **Test-only races fixed** in the new script: typing into a panel while the previous submit was still in flight, and checks matching CSS-uppercased labels.
- **Design fix after the screenshots**: table tiles carry a small labelled archive icon instead of a full red button.

## Phase 4 slice 6b — kitchen display (session 6)
- **POS kitchen mode** (`components/Kitchen.tsx`): users with `kitchen.operate` get "Open kitchen display" on the register picker (no register or drawer needed; kitchen-only users no longer see "no register access"). They pick a branch and a station, or all stations. The board polls open tickets every 4 s, oldest first, and keeps the last tickets on screen if the connection drops. Each ticket shows:
  - table or takeaway name, order and ticket number, course, and station code (all-stations view);
  - elapsed time, amber "Late" after 10 min;
  - items with choices, seat and note, each with Start → Ready, and "All ready (bump)".
  Every action is single-flight per item or ticket.
- **API**: `GET /v1/branches` also lists a branch to holders of `kitchen.operate` there (their branches only), so kitchen crew can pick it. Test added to "who sees which branch".
- **E2E** `pnpm test:e2e:kitchen` (new) **13/13**, three consecutive runs:
  - the picker offers the KDS, with Grill and Bar stations;
  - the grill ticket shows the burger with its choices and note, and never the bar's tea;
  - Start → IN_PREP on the server; bump → READY, and the bump button goes;
  - served by the floor → leaves the board;
  - all stations shows the bar ticket marked BAR;
  - no sideways scroll at 1024/390; Filipino.
  The restaurant arrangement is shared with the tables E2E (`e2e/restaurant.mjs`).
- One first-run failure was a race in the test, not the product: an item's own "Ready" button was matched before the bump landed. The test now waits for the bump.

## Phase 4 slice 6a — POS table service (session 6)
- **E2E re-run after the slice-4 checkout refactor** (open item from slice 4): fresh API on :4321 (the stale API/web from 12:05 still hold :4320/:3320 and were left alone), admin on :3321, POS preview on :3330 → `test:e2e:pos` **19/19**, `test:e2e:web` **42/42**.
- **API**: `POST /v1/restaurant/bills/:id/checks/preview` prices a check (same allocations) without recording it, so the till shows the exact amount before taking money and never prorates itself. Pricing moved into one private `priceCheck()` that `createFromBill` and the preview share. The real check still sends `expectedAmountDue`, so a check paid at another till in between is refused as `TOTAL_CHANGED`. Needs `restaurant.orders` or `sales.create` at the bill's branch. `bills.test.ts` +1 (a third = ₱157.66, preview = check, nothing recorded, stale preview refused); isolation attack matrix +1 route.
- **POS** (`apps/pos-desktop`), new **Tables** tab (shown with `restaurant.orders`; kept mounted like Sell so a check's card payment survives a tab switch):
  - floor: areas, table notes (violet; free / open / billed, to send, ready), takeaway orders, open a table with guests or a takeaway with a name; polls every 8 s;
  - order: published menu by section, modifier composer (required/max choices, quantity, course, kitchen note), ticket with status tags, send all / by course, served, void after firing (manager, reason, written off or not), remove pending, move table, cancel; server-priced subtotal via `/v1/tax/quote`; polls every 5 s;
  - bill: SC/PWD diners per item and an order discount before printing; lines with paid shares, service charge line, reopen (no checks yet); checks by "everything left", "split evenly" (exact shares of what is left) or by item, each previewed by the server.
  - Payment is now one `usePayment` hook + `PaymentPanel` shared by the counter and checks: intents, unknown outcomes, kept keys, duplicate → recorded sale. Counter E2E unchanged after the move (19/19).
- **Defect found and fixed**: the POS receipt never rendered `charges`, so a check's slip omitted the service charge line (ADR-0014 §9). It now prints on its own line.
- **E2E** `pnpm test:e2e:tables` (new, `apps/pos-desktop/e2e/tables.mjs`) **25/25**: required choice blocks adding, burger ×2 with Medium + Cheese, subtotal ₱340 → ₱430, send to kitchen, extra tea voided, bill ₱473.00 with the charge line, split evenly ₱236.50 cash (change ₱13.50, receipt with charge) + ₱236.50 card → settled, T1 free, takeaway bill ₱45.00 without a charge, drawer ₱1,236.50, no sideways scroll at 1024/390, Filipino.
- DESIGN.md: restaurant records map to existing denominations (places violet, menu blue, recipes gold, orders/bills/tickets unstriped with worded states).

## Phase 4 slice 5 — restaurant reports (session 6)
- **API**: six read-only reports in `apps/api/src/reports/restaurant-reports.service.ts`. Each needs `reports.read` at the branch, is not plan-gated, and uses the same local-day conventions as the retail reports. Details are in ADR-0014 §10.
  - `GET /v1/reports/item-performance`: items with their priced modifiers nested under them; quantity, net sales, revenue ex VAT, COGS (incl. recipe), margin, and "with modifiers" totals.
  - `GET /v1/reports/ingredient-usage`: per recipe ingredient, expected (recipe + sold as itself) vs actual (+ prepared waste + other waste − count variance), in quantity and value.
  - `GET /v1/reports/kitchen-voids`: voids after firing with the stage reached, wasted or not, and WASTE value; by reason and by user.
  - `GET /v1/reports/prep-times`: per station and overall: fired → ready (avg/median/p90/max), wait to prep, ready → served.
  - `GET /v1/reports/open-orders?branchId&day`: open or billed at the close of the day (or now), with what had been paid by then.
  - `GET /v1/reports/service-charge`: per day charged − returned, the distributable amount (ex VAT) and a ledger cross-check against `SERVICE_CHARGE_PAYABLE`.
- **Defect found and fixed (slice 4)**: a check's service-charge `base` was always prorated, never the remainder. An even split of a ₱383.93 base recorded 191.97 + 191.97 = ₱383.94. The settling check now takes the rest, and `bills.test.ts` now asserts Σ bases = the bill's base. Amounts were never affected.
- **Test fixed (flaky, pre-existing)**: `costing.test.ts` ordered the three sale movements by `created_at`, which the Docker clock can step backwards (see session 3). It now orders by sale number.
- **Tests**: `restaurant-reports.test.ts` (8). One service day covers: a split table with a return, a wasted void while cooking, a void before cooking, a half-paid takeaway, a cancelled order, spoiled beef and a short count. Every report is checked against hand-computed figures and the evidence rows:
  - item performance = by-product = sale lines − return lines;
  - usage = movements by type;
  - void waste = its journal entry;
  - distributable = the liability credit.
  It also asserts the ADR §10 invariants (consumption = sold × recipe in force; every fired item accounted for exactly once), checks access and validation, and ends with a clean traceability audit.
- **Isolation**: the six reports are in the smuggle matrix and the deep scan. No new `:id` routes.
- **Docs**: ADR-0014 §10 "as built", DOMAIN_MODEL "Phase 4 invariants", OpenAPI regenerated.

## Phase 4 slice 4 — bills, split checks, service charge (session 6)
- **Schema**: migrations 0039/0040, all with forced RLS.
  - New tables: `order_bills`, `order_bill_lines`, `order_bill_beneficiaries`, `order_bill_charges`, `order_bill_allocations`, `sale_charges`, `sale_return_charges`.
  - New columns: `sales.order_bill_id` and `sale_lines.parent_line_id` (same-sale FK).
  - Bill evidence is append-only. The bill state trigger allows ACTIVE → SETTLED/VOIDED, and voiding is refused once a check is paid.
  - Allocation guard: each line's shares are summed as exact fractions under the bill row lock, never more than 1.
  - The new system account `SERVICE_CHARGE_PAYABLE` (2200) is in `DEFAULT_CHART` and back-filled for every entity (dev: applied).
- **Tax engine**: `serviceCharge()` charges base = items net of every discount, ex VAT, then taxes the charge as its own line (VAT seller: VAT on top; non-VAT: percentage-tax sales). Unit-tested, including the SC/PWD discounted base, the non-VAT seller and rounding.
- **Accounting**: `salePosting` / `saleReturnPosting` credit or debit `SERVICE_CHARGE_PAYABLE` with the charge ex VAT; its VAT stays in output VAT (unit test).
- **Bill** (`POST /v1/restaurant/orders/:id/bill`):
  - priced by `TaxService.computeCart` over live items, with priced modifiers as child lines;
  - SC/PWD per item, itemized or shared;
  - order `discountRate` (sales.discount) spread over non-statutory lines;
  - service charge from branch settings;
  - `requiresProfessionalReview` when SC/PWD meets the service charge;
  - order → BILLED (no adds or voids); reopen via `/void` only before any check.
- **Checks** (`POST /v1/restaurant/bills/:id/checks` → `SalesService.createFromBill`):
  - allocations by whole quantity or n/d share; omitted means "pay the rest"; modifiers follow their item;
  - proration rounds the amount due first and gives one sales bucket the residual, so even splits look right; the final share takes the exact remainder;
  - the charge follows the check's share of the items' amount due;
  - the last check settles the bill and the order.
  - `SalesService.create` was refactored so retail and checks share one `record()` path (tenders, numbering, lines with parents, charges, allocations, stock + consumption, books, audit, outbox). The 74 existing checkout/returns/drill/ledger/report tests passed on the new path before the new tests were written.
- **Returns**: the charge goes back in proportion to the items returned; the return that empties the sale takes the rest; the liability is reversed.
- **Receipts and reports**: the receipt prints "Service charge 10%" on its own line. By-product lists `charges` apart, so Σ products + Σ charges = summary.
- **Defect found and fixed (slice 1 gap)**: by-product COGS ignored CONSUMPTION, so dishes showed full gross profit. Consumption is now attributed to the sold line's item.
- **Tests**: `bills.test.ts` (5):
  - the full SPEC service cycle: modifiers, kitchen, bill ₱473.00 = items ₱430 + charge 38.39 + 4.61 VAT, even split 236.50 + 236.50, settled, table freed, Σ checks = bill per bucket, stock once per dish, GL (Sales 383.93, charge payable 38.39, output VAT 50.68, COGS 136), audit clean, receipt, reports reconcile, shift closes balanced;
  - splits by item/quantity, over-payment refused, 3 concurrent "pay the rest" → one;
  - SC itemized (₱107.14, charge on the discounted base) + discount on non-statutory lines + reopen rules + beneficiary on the check;
  - returns of a charged check (charge 9.00 with the tea, then the rest; liability nets to 0);
  - DB guards (fraction guard refuses 1/3 + 3/4, append-only, no reopen after a check).
- **Isolation**: +4 id routes, +2 smuggling cases, 3 list scans, all 7 tables in the sweep (the fixture bills with an SC diner, pays, returns part).

## Phase 4 slice 3 — orders and kitchen (session 6)
- **Schema**: migrations 0037/0038 add `restaurant_orders`, `kitchen_tickets` and `order_items`, all with forced RLS. Composite FKs pin an order's table and a ticket's order and station to the same branch.
- **DB guarantees** (triggers and column grants):
  - order transitions OPEN → BILLED → SETTLED, BILLED → OPEN, OPEN → CANCELLED/MERGED; closed orders never change;
  - one live order per table (partial unique index);
  - items are inserted as PENDING into open orders only, beside a parent of the same order;
  - fired items are frozen (quantity/course; variant, kind and name are never updatable);
  - status only moves forward or to VOIDED (final);
  - only pending items can be deleted, and items move only into open orders;
  - orders and tickets are never deleted.
- **API** (`orders.*`, `kitchen.service.ts`):
  - open (dine-in on a free table / takeaway), list (live/all, with item counts), get (items with modifiers, tickets);
  - add items (required Idempotency-Key) validated against the branch's published menu: on menu, available (priced, not 86), modifiers within each group's min/max, whole units;
  - edit/remove pending items (modifiers follow);
  - void fired items (`sales.void`, required key); a *wasted* void writes one WASTE stock adjustment (tracked item itself or its recipe, plus tracked priced modifiers) with its journal entry;
  - fire by course → one ticket per station and course (station code, else default; refused with no station); re-fire is a no-op;
  - transfer table, merge, move items (to an open order or a new order on a free table), cancel (only when nothing live was cooked);
  - KDS ticket list (open/all, per station, shows where the food goes now), item status (IN_PREP/READY kitchen; SERVED kitchen or floor) and bump;
  - archiving a table is refused while it has a live order.
- **Tests**: `orders.test.ts` (6):
  - order taking: table occupied, menu rules, sold-out, key required, replay not doubled, pending edits with modifiers following, access;
  - kitchen: course firing into station tickets, no-op re-fire, frozen fired items, KDS view, permissions per status, no going backwards, bump, served by floor, branch without a station;
  - voids: cashier refused, wasted void → WASTE document (₱136 = 2 buns + 0.3 kg beef + 2 cheese slices) with entry and clean audit, non-wasted void has no stock effect, cancel after all voided;
  - moving: transfer, merge, move to a new table (KDS follows), whole-item moves only, cancel rules, table archive refused;
  - drills: 5 concurrent opens of one table → 1, 10 concurrent adds from two tablets → all once, 5 concurrent fires → each item once, opposite-direction merges → one wins, no deadlock;
  - DB guards.
- **Isolation**: +12 id routes, +10 smuggling cases, 3 more list scans, all 3 tables in the DB sweep.
- **Defect found by the isolation suite and fixed**: move-items to a new table created the order before validating the items, so a bad item id answered `TABLE_OCCUPIED` instead of 404 (and could have opened a table for nothing). Items are now validated first.

## Phase 4 slice 2 — menu foundation (session 6)
- **Schema**: migrations 0035/0036 add 12 tables, all with forced RLS:
  - floor: `kitchen_stations`, `dining_areas`, `restaurant_tables`;
  - modifiers: `modifier_groups`, `modifier_options`;
  - menus: `menus`, `menu_versions`, `menu_sections`, `menu_items`, `menu_item_modifier_groups`;
  - per branch: `restaurant_settings`, `sold_out_items`.
- **DB guarantees**:
  - set-up rows are archived, never deleted;
  - station codes are unique per branch, with one default station;
  - a table's area is pinned to the same branch by composite FK, and an item's section to the same version;
  - one draft and one published version per menu;
  - versions only go DRAFT → PUBLISHED → RETIRED and are inserted as drafts;
  - published and retired content is frozen (trigger);
  - min/max choice bounds.
- **API** (`apps/api/src/restaurant/floor.*`, `menus.*`):
  - stations, areas and tables (CRUD + archive);
  - modifier groups and options (archive refused if it leaves too few options);
  - menus: create (draft v1), rename, archive (refused while a branch serves it), new draft copied from published, replace draft content, publish (locks the menu; retires the previous version);
  - per-branch settings (menus per order type, service charge rate / order types / VAT treatment);
  - 86 list/set;
  - `GET /v1/branches/:id/menu`: the published menu with branch prices, option prices, sold-out and availability.
- **Access**:
  - set-up needs `restaurant.manage` at the branch (tenant-wide for menus/modifiers) plus the `restaurant` plan feature;
  - floor staff and kitchen read their branch's set-up;
  - 86 needs `kitchen.operate` or `restaurant.manage`;
  - the POS menu needs `restaurant.orders`.
  - Finding: the built-in branch manager has no `restaurant.manage`, so only owner/admin can set up a restaurant (BACKLOG: decide on a restaurant-manager template).
- **Tests**: `menu.test.ts` (7):
  - floor rules, including a cross-branch area move refused by API and FK;
  - access, including the plan gate;
  - modifier bounds;
  - version lifecycle with DB-level freeze, no going back, and insert-as-published refused;
  - 5 concurrent publishes → one;
  - archived references block publishing;
  - branch menu with prices, sold-out and unpriced items, menu in use.
- **Isolation**: +22 id routes, +12 smuggling cases, 9 more list scans, all 12 tables in the DB sweep, and A's set-up checked untouched.
**Phase 3 — exit criterion met** (session 5). Outside review still open: the accountant's answers (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`). Customers must not rely on the books until then.
**Phase 2 — exit criterion met** (session 4, see below).

## Phase 4 slice 1 — recipes and consumption (session 6)
- **Plan** (ADR-0014) has seven slices. Key decisions:
  - menu items are catalog variants (one price and tax path);
  - an order is operational only and becomes sales through a frozen **bill**;
  - **split checks are exact prorations** of the bill (as returns are);
  - service charge is a separate charge line posted to a liability (`SERVICE_CHARGE_PAYABLE`, RA 11360); the defaults are flagged for the tax adviser and the accountant;
  - a void after cooking becomes a WASTE document.
- **Schema**:
  - Migrations 0033/0034: `recipe_versions` (numbered, effective-dated, append-only, never backdated) and `recipe_ingredients` (append-only).
  - Triggers: the sold item must not track stock, and the ingredient must.
  - New movement type `CONSUMPTION` (outbound, linked to sale + sale line + recipe version; type/direction/link checks updated). The costing trigger needed no change.
- **Checkout**: `SalesService.create` adds one CONSUMPTION per line and ingredient for untracked lines with a recipe in force (DB clock). These are sorted by variant with the sale's movements, and their value is in the sale's COGS, so the sale still has one entry.
- **Returns**: RESTOCK of a recipe-made line → `422 NOT_RESTOCKABLE`. A void records such lines as DAMAGED. Ingredients stay consumed.
- **API**: `GET/POST /v1/variants/:id/recipe` (history with IN_FORCE/SCHEDULED/SUPERSEDED; create needs `restaurant.manage` and the `restaurant` plan feature). Consumption is not feature-gated.
- The traceability audit maps CONSUMPTION → its SALE. Admin movement label added ("Used in recipes" / "Nagamit sa recipe").
- **Tests**: `recipes.test.ts` (5):
  - golden burger costs (bun/beef/cheese at average), sale entry COGS = ingredients + shelf item, movements report;
  - versions (scheduled waits, new version applies, empty stops consumption, backdating refused in API and DB, append-only);
  - rules and access, including a starter-plan downgrade where consumption continues;
  - DAMAGED-only returns and the void restocking only shelf items;
  - 10 concurrent dish + shelf sales sharing an ingredient in opposite orders (no deadlock, ledger = balances);
  - the audit is clean in every case.
- **Isolation**: +2 id routes, +1 smuggling case, both new tables in the DB sweep (the fixture sells a dish).

## Verified in session 6 (commands actually run)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` (exit 0) · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **113 passed** (unchanged) |
| `pnpm test:integration` | **236 passed**: database 21, api **207** (+5 recipes; isolation extended), workers 8 |
| `pnpm db:migrate` (dev) | 0033, 0034 applied |
| slice 2: `pnpm build` · `pnpm typecheck` · oxlint (exit 0) · openapi · `pnpm test` | ok |
| slice 2: `pnpm test:integration` | **243 passed**: database 21, api **214** (+7 menu; isolation extended), workers 8 |
| slice 2: `pnpm db:migrate` (dev) | 0035, 0036 applied |
| slice 3: `pnpm build` · `pnpm typecheck` · oxlint (exit 0) · openapi · `pnpm test` | ok |
| slice 3: `pnpm test:integration` | **249 passed**: database 21, api **220** (+6 orders; isolation extended), workers 8 |
| slice 3: `pnpm db:migrate` (dev) | 0037, 0038 applied |
| slice 4: `pnpm build` · `pnpm typecheck` · oxlint (exit 0) · openapi · `pnpm test` (tax **30**, accounting **14**, api 34, …) | ok |
| slice 4: `pnpm test:integration` | **254 passed**: database 21, api **225** (+5 bills; isolation extended), workers 8 |
| slice 4: `pnpm db:migrate` (dev) | 0039, 0040 applied (service charge account back-filled) |
| slice 5: `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` (exit 0) · openapi · `pnpm test` (api 34, tax 30, accounting 14, …) | ok |
| slice 5: `pnpm test:integration` | **262 passed**: database 21, api **233** (+8 restaurant reports; isolation extended), workers 8. The first run had 1 failure in `costing.test.ts` (clock-order flake, passed alone; fixed as above); the rerun was all green |
| slice 6a: `test:e2e:pos` / `test:e2e:web` against a freshly built API (:4321) | **19/19** / **42/42** (re-run owed since slice 4: done) |
| slice 6a: `pnpm exec vitest … bills.test.ts isolation.test.ts` · `pnpm test` · typecheck · oxlint · openapi | bills **6**, isolation 9, unit all green |
| slice 6a: `pnpm test:e2e:tables` | **25/25** |
| slice 6b: isolation + inventory-drills (19) · `test:e2e:kitchen` ×3 · `test:e2e:tables` · `test:e2e:pos` | all green: 13/13, 25/25, 19/19 |
| slice 6c: admin typecheck · oxlint · admin unit (8) · `test:e2e:web:restaurant` · `test:e2e:web` (fresh build on :3321) | 22/22 · 42/42 |
| slice 6d: `pnpm test:integration` | **263 passed**: database 21, api **234**, workers 8 |
| slice 6 close: all six E2E suites against freshly restarted API (:4321), POS preview (:3330) and admin (:3321) | `test:e2e:pos` 19/19 · `tables` 25/25 · `kitchen` 13/13 · `web` 42/42 · `web:restaurant` 22/22 · `web:reports` 19/19 (140 checks) |
No migrations in slices 5–6. An API process from before this slice (PID 18856, started 12:05, not started by this session) was holding port 4320, so a fresh API could not start; it was left running. Re-run both E2E suites against a rebuilt API before the exit review, because checkout was refactored.
Not re-run: `pnpm test:e2e:web` / `test:e2e:pos` (admin change is one label and one filter option; POS untouched).

## Phase 3 exit review (session 5)
**1. Traceability audit.** `apps/api/test/integration/traceability-audit.ts` checks seven SQL invariants per tenant, in both directions:
- movement → document → entry: every movement has a document, and every document that moved value has exactly one entry;
- entry → document: every non-manual entry's document exists, in the same entity;
- per document and branch, the entry's inventory amount = that document's movement values;
- goods in transit clear on receipt.

Where it runs:
- `traceability.test.ts`: clean over a mixed day covering every document type, and mutation-tested (a forged entry is reported).
- `inventory-drills.test.ts`: at the end of every drill.
- **Over the dev database** (54 tenants, after migrating): no violations, except 39 sales, returns and cash variances that predate the ledger. All were created before the first journal entry anywhere; migration 0028 doesn't post history. Accepted and noted in ADR-0013.

**Defects found and fixed:**
- **Multi-item stock adjustments had no document.** The journal entry pointed at the first movement only, so the other items couldn't be traced to their entry. Fixed with the `stock_adjustments` document (migration 0031):
  - movements link to it, enforced by a DB check;
  - existing rows were back-filled, each document reusing the movement id its append-only entry already names;
  - new routes `GET /v1/stock/adjustments[/:id]` (isolation matrix extended), and an admin page linked from the journal.
- **A posting could land in a month being closed.** The closed-period trigger read the period without a lock. It now ensures the period row exists and holds it `FOR SHARE` (migration 0032). The trigger's refusal maps to `409 PERIOD_CLOSED`. Proved by a drill that fails on the old trigger and passes on the new one.

**2. Drills** (`inventory-drills.test.ts`, 10), each ending with the audit:
- connection killed mid-receipt → 503, nothing written, no number consumed; the same key then receives once;
- DB unreachable for a receipt, a transfer and a count → 503, nothing written;
- double-click on receive (same key ×5) → one receipt;
- five people receiving one transfer → it arrives once, the others get `ALREADY_RECEIVED`;
- four concurrent supplier returns of the last units → exactly one;
- receipts, transfers, counts, waste and adjustments on the same two items in opposite orders, all at once → no deadlock; balances = ledger, GL inventory + transit = Σ movement values;
- four concurrent reversals → one;
- close vs posting in both orders;
- inventory officers see only their own branches.

**3. Permissions.** `GET /v1/branches` now also lists a branch to users with `inventory.read`/`adjust`/`transfer` or `purchasing.manage` there (only their branches; cashiers unchanged). The built-in inventory officer role can now use the admin's branch pickers.

**4. Design finish review** of the new admin screens (impeccable-finish-reviewer, 8 material fixes, all applied):
- branch codes violet, not gold;
- phone rows label and sign every figure (PO received/rejected/remaining, movements with signed changes, low stock leads with "Suggested order");
- trial balance shows balances with Dr/Cr (catalog keys) and opening on phones;
- the journal's phone rows lead with the entry number, with the memo out of the serial line;
- the manual entry shows running debit/credit/difference and can't be posted unbalanced;
- the receive panel has its own row;
- the send-stock form names its source branch;
- ScopePicker is a `nav` with `aria-current` (not fake tabs), and SubNav fades at the edge and scrolls the active tab into view.

**5. Accountant review request** with 10 questions: GRNI vs AP, input VAT, SC/PWD presentation, revaluation to COGS, clearing account, drawer funds, deductibility of losses, percentage tax, year-end close, numbering.

## Verified in session 5 — exit review (commands actually run)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **113 passed** |
| `pnpm test:integration` | **231 passed**: database 21, api **202** (+ traceability 2, inventory drills 10), workers 8 |
| `pnpm test:e2e:web` / `node apps/admin-web/e2e/review.mjs` | **42/42** (+ adjustment entry → document) / **35/35** |
| `pnpm db:migrate` (dev) | 0031, 0032 applied; dev audit as above |
| mutation check | old period trigger restored on the test DB → close-wait drill **fails**; new trigger → passes |

Not re-run: `pnpm test:e2e:pos` (POS untouched).

## Phase 3 slice 5 — admin UI (session 5)
Three new admin areas on the real API through the BFF (allow-list extended: suppliers, purchase-orders, goods-receipts, stock, accounts, journal-entries, accounting), EN/FIL, Salapi:
- **Purchasing** (`/purchasing`): suppliers (add), purchase orders with status filter and "new order" with editable lines; order page (`/purchasing/orders/:id`): approve, cancel/close with reason, **receive goods per line (accept / reject + reason, invoice and DR refs)**, lines with ordered/received/rejected/remaining, its receipts; receipt page (`/purchasing/receipts/:id`) → its journal entry.
- **Inventory** (`/inventory`, section tabs + branch picker): stock & value (inventory-valuation report, total checked against the ledger value), low stock with "set reorder point"; transfers (send stock to a same-entity branch → transfer page with receive form: arrived per line + shortfall reason, value sent / in transit / lost); counts (post a count → variance qty/value, signed); movements report (opening + by type = closing, date range).
- **Books** (`/books`, section tabs + entity picker; callout: chart and rules await an accountant): journal with **source links both ways** (document → `/books?source=`, entry → document; account → its entries), manual entry (≥2 lines, debit/credit), entry page with reversal (reason), trial balance (from/to, balance check), chart of accounts (add), periods (close a month / reopen with reason).
- Shared: `RecordTable` (table on desktop, stacked rows below md with the key figure visible, totals row), `SubNav`, `ScopePicker`, `LineItems` (inputs named `lines.<i>.<field>` so API issue paths land on the row), `ReasonAction`/`ActionButton`. **Stock and books documents keep one Idempotency-Key per open form** (`useFormKey`), so a resubmit after no answer replays instead of posting twice. Exact decimal helpers (`sumDecimal`, `signOf`, `qty`) — no floats for money/quantities in the admin.
- Design: two new denominations documented in DESIGN.md — **₱500 gold = goods** (stock, suppliers, purchasing), **ink stripe = books**; negatives print with a true minus.
- Defects found by running it and fixed: `Serial` hard-coded `text-muted`, so coloured serials (supplier codes, and the existing "ink" SKUs on prices/locations) rendered muted → now merged with tailwind-merge; movements footer put a value under a quantity column; `peso()` printed a hyphen minus and could print "−₱0.00".
- Known gaps (in BACKLOG): the admin's branch/entity pickers need `org.read` — the built-in *inventory* role lacks it, so an inventory clerk sees "no access" on Inventory/Purchasing pickers; supplier returns, PO draft editing, supplier edit/archive and journal filters by date/type have API support but no UI yet; item names on receipts come from the first 200 products.

## Verified in session 5 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` | ok, no warnings |
| `pnpm test` | **113 passed** (api 34, tax 27, money 15, accounting 13, config 6, admin-web **6 new** (format helpers), validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **219 passed** — database 21, api 190, workers 8 (API unchanged this session) |
| `pnpm test:e2e:web` | **41/41** (+22): supplier → PO ₱912.00 → approve → receive 20+48 with 4 rejected (₱852.00, partly received) → receipt → its journal entry and back → stock value ₱852.00 = ledger → transfer 5, receive 4 with reason (₱15.00 lost; refused without reason) → count 46 vs 48 (−2, −₱23.00) → trial balance balances → close/reopen last month → manual entry + reversal → still balances; 390px: no sideways scroll on inventory/purchasing/books/trial balance |
| `node apps/admin-web/e2e/review.mjs` | **35/35** (+16 new states × 1440/390 incl. FIL) → `.impeccable/review/screens/` |
Not re-run this session: `pnpm test:e2e:pos` (POS untouched).

## Phase 3 (session 4)
- **Slice 1 — costing (ADR-0012)**: migrations 0022/0023. Every stock movement carries `unit_cost`/`value`; balances carry `value`/`avg_cost`; a `BEFORE INSERT` trigger (owned by `onepos_platform`) costs each movement under the balance row lock — outbound at the average (emptying takes the exact remainder), customer returns at the sale's cost, inbound averages; a receipt after selling short restarts the average and shows the revaluation. Inserts sorted by variant (lock order). `costing.test.ts` (6): golden vectors, rounding remainder, defaults, app cannot choose an outbound cost or bring stock in without one, 12 concurrent opposite-order multi-item sales.
- **Slice 2 — purchasing**: migrations 0024/0025, `apps/api/src/purchasing`. Suppliers; purchase orders (DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED → CLOSED / CANCELLED, trigger-enforced, draft-only edits); goods receipts (accepted vs rejected with reason, invoice/DR refs, order lock + DB over-receipt guard); supplier returns (average out, credit at receipt cost, DB guard). `purchasing.test.ts` (8).
- **Slice 3 — inventory ops**: migrations 0026/0027, `apps/api/src/inventory`. Transfers (in transit → received once, shortfall reason, arrive at dispatch cost, same legal entity only); counts (variance = counted − on hand computed by the trigger at posting; equal → no movement); waste; reorder points + low stock net of open orders; reports `inventory-valuation`, `stock-movements`, by-product revenue ex VAT / COGS / gross profit. `inventory.test.ts` (6).
- **Slice 4 — double-entry ledger (ADR-0013)**: migrations 0028–0030, new pure package `@1pos/accounting` (posting rules + default chart, 13 unit tests), `apps/api/src/accounting`. Chart per legal entity (seeded on create, back-filled), months as periods, append-only journal; every sale, return/void, goods receipt, supplier return, adjustment/waste, count, transfer dispatch/receipt, pay-in/out and drawer variance posts one balanced entry in its own transaction; manual entries, reversals (once), period close (not the month in progress) / reopen (reason), trial balance. `ledger.test.ts` (5): one entry per document, GL inventory/transit/cash/clearing/output VAT/revenue/COGS/GRNI/waste/adjustments = evidence, trial balance balances, DB refuses unbalanced entries at commit and entries in closed months.
- Isolation suite now covers 15 more id routes, ~31 more smuggling cases and 16 more tables.
- **Defects found and fixed this phase**: (1) migration 0023's legacy-cost backfill ran under FORCE RLS and updated nothing (only the throwaway test DB had run it) — fixed in place with `NO FORCE` around the backfill, same pattern as 0014; dev DB verified (balances = Σ movement values; all 29 entities got the 17-account chart). (2) The journal balance trigger referenced `NEW.journal_entry_id` in a CASE plpgsql resolves for both tables → every posting failed; fixed by 0030 (found by the full integration run).
- Dev DB migrated to 0030.

## Verified in session 4 — Phase 3 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (18/18) · `pnpm exec oxlint apps packages` · `pnpm --filter @1pos/api openapi` | ok, no warnings |
| `pnpm test` | **107 passed** (api 34, tax 27, money 15, accounting 13, config 6, validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **219 passed** — database 21, api **190** (+ costing 6, purchasing 8, inventory 6, ledger 5; isolation extended), workers 8 |
| `pnpm test:e2e:pos` / `pnpm test:e2e:web` | **19/19** / **19/19** against the live API with posting enabled |
| `pnpm db:migrate` (dev) | 0022–0030 applied; backfills verified by SQL |
Slices 1 (`7ee1f3a`), 2 (`f0fd882`), 3 (`67486d7`), 4 (`5fb1071`), 5 (`b70936c`), 6 (`694d448`) done. Phase 1 done (`5878fc8`, `980eeda`). Phase 0 done (`159b94e`).

## Phase 2 exit review (session 4)
**1. Reconciliation audit** — chain sale → tenders → drawer → stock → reports → session traced through `SalesService`, `ReturnsService`, `CashService`, `ReportsService`. Untested paths found and now covered by `apps/api/test/integration/reconciliation.test.ts`:
- a multi-register, multi-session day: two shifts on R1 + one on R2, card / QR+cash / SC sales, a **card-paid sale refunded in cash** from another cashier's drawer (ADR-0011: cash refunds only), a damaged return and a void in a later session. Asserted: summary/by-tender/by-product/by-cashier/tax-summary net all equal Σ sales − Σ returns from the evidence tables; each session report holds only its own drawer movements; Σ drawers − floats = cash collected − cash refunded; recorded `expected_cash` = ledger and nothing posted after close; every intent consumed once; stock balance = Σ ledger = opening − sold + restocked.
- local business days at UTC+14 and UTC−11 (same instant → different days; ±1 day excluded). **Not tested:** one session physically spanning local midnight (needs clock control); covered by construction (session reports filter by session id, day reports by instant ranges — both tested).
- Invariants written down in `docs/architecture/DOMAIN_MODEL.md` ("Reconciliation invariants").

**2. Failure drills** — `apps/api/test/integration/failure-drills.test.ts` (8): API restart after commit (fresh instance replays the same key; new key + same transaction → `DUPLICATE_TRANSACTION` with `saleId`); **DB connection killed mid-checkout** (backend terminated while the sale waits on the session row lock → 503, nothing written, same key then sells once); **DB unreachable** (quote, payment, sale → 503, nothing written); **DB restart while idle** (dropped pool connections discarded); provider timeout (sale refused, close refused, reconcile → one charge); authorized card whose sale failed; never-received request; double-click/retry/new-key duplicates → one sale.
Defects found by the drills and fixed:
- **API process crash on a dropped DB connection** — pg emits `'error'` on a checked-out client whose server connection dies; unhandled, it exits Node. `transaction()` (`@1pos/database`) now listens while the client is checked out and destroys broken clients (`release(err)`); API and worker pools have `'error'` listeners for idle clients.
- **DB failures answered 500** → now **503 `SERVICE_UNAVAILABLE` + `Retry-After`** (`isTransientDbError`: connection errors, SQLSTATE 08/57P01-03/53300/57014/40001/40P01; unit-tested).
- **Orphan charges**: a shift could close with a card payment authorized but in no sale (or UNKNOWN) → close now `409 PAYMENTS_OUTSTANDING` (ADR-0010 §6).
- **Resubmit dead end**: `DUPLICATE_TRANSACTION` now carries `saleId`/`saleNumber`; the POS shows that sale's receipt.
POS (unknown-outcome handling): no answer **or 5xx** keeps the Idempotency-Key for sales, card/QR requests and returns (5xx used to mint a new key); a card/QR request with no answer is retried with the same key, and a different payment first re-reads the session's intents; double-click guarded; Card/QR disabled while a payment has no answer; PROCESSING gets "Check payment"; **Sell stays mounted behind other tabs** (switching to "This shift" used to drop the cart and any authorized payment); close screen lists unsettled payments with Check/Cancel. **POS business picker was broken** (expected `tokens` from `/auth/switch-tenant`, which returns `accessToken`) — fixed; found by the review pass.

**3. POS review captures + design finish review** — new `apps/pos-desktop/e2e/review.mjs` (14 states × 1440/390 → `.impeccable/review/pos/screens/`, 30 checks). Finish review (impeccable-finish-reviewer) returned 11 material fixes; done: money inputs had no box (`Field` className overwritten), Card/QR enabled during "no answer", raw status enums/failure codes and "Paid by" on declined payments (now worded + coloured tags, EN/FIL), change due at figure size, all counter targets 48px, "Remove discount" as a button and trash spaced apart, close screen order/disabled submit/danger cancel, variance shown as Expected/Counted/Short-Over, receipt deductions with "−" and TOTAL DUE → tenders → tendered → change, sale time in shift history, reason shown when Complete is disabled. Deferred to BACKLOG: sticky total/pay bar on phones, tender + voided/returned tags in shift history, SC block duplicate discount line on receipt.

**4. Docs** — ARCHITECTURE §5/§6 rewritten "as built" (ADR-0008..0011, one-transaction checkout, failure semantics), DOMAIN_MODEL state machines as built + reconciliation invariants, ADR-0010 §6, API CONVENTIONS (409 codes, 503), CLAUDE.md commands.

## Verified in session 4 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` (16/16) · `pnpm exec oxlint apps packages` | ok, no warnings |
| `pnpm test` | **94 passed** (api 34 incl. 12 new transient-error cases, tax 27, money 15, config 6, validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **193 passed** — database 21, api **164** (+8 failure drills, +2 reconciliation), workers 8 |
| `pnpm test:e2e:pos` | **19/19** (+4: cart survives tab switch, double-click → one sale R1-000003, close refused over an unsettled card payment, cancel → balanced) |
| `node apps/pos-desktop/e2e/review.mjs` | **30/30** |
| `pnpm test:e2e:web` | **19/19** (shared CDP harness now prefers visible elements) |
Note: the integration run preceded the final POS-only UI edits; API/database code did not change after it.

### Phase 2 slice 1 — tax foundation (session 3)
- ADR-0008 (`docs/decisions/ADR-0008-tax-engine.md`): seller = versioned `tax_profiles`, item = `tax_categories.vat_treatment`, buyer entitlement = platform `discount_schemes`; pure engine; per-line centavo rounding; snapshots; review gate.
- DB: migrations 0014 (tables + backfill: every existing legal entity got its current VAT status/rounding as an initial profile — dev DB: 10 VAT, 2 non-VAT — then `legal_entities.vat_status/rounding_mode` dropped) and 0015 (forced RLS, append-only + no-backdating triggers, grants, SC/PWD seed).
- `@1pos/tax`: golden vectors ₱1,120 → ₱800 (VAT seller, SC) and ₱1,120 → ₱896 (non-VAT, PWD), mixed carts, exclusive prices, partial beneficiary share, refusals (stacking, unsupported VAT-keeping schemes, bad profiles), 2,000 random carts checking every peso is accounted for once.
- API: `GET/POST /v1/legal-entities/:id/tax-profiles` (create needs `tax.manage`; VAT status no longer editable via PATCH — 400), `GET /v1/discount-schemes`, `POST /v1/tax/quote` (server-authoritative price + tax for a cart at a branch; cashier allowed incl. SC/PWD; ordinary discounts need `sales.discount`; branch scope enforced; `requiresProfessionalReview` flag).
- Defect found & fixed: price and profile effective dates mixed the API host clock with the DB clock (Docker drift ≈0.2 s) → a just-set price/profile could read as "not yet effective". The DB clock is now the single clock for effective dating (`apps/api/src/common/clock.ts`).
- Guards worked as intended: the schema guard flagged the new global table (allow-listed with reason) and the router guard flagged the 2 new `:id` routes (added to the attack matrix + 2 quote smuggling cases).

### Phase 2 slice 2 — sales core (session 3)
- ADR-0009. Migrations 0016/0017: `cashier_sessions`, `cash_movements`, `cash_reconciliations`, `sequence_counters`, `sales`, `sale_beneficiaries`, `sale_lines`, `sale_tenders`, `stock_movements`, `stock_balances` — forced RLS, append-only evidence tables, session state-machine + open-session triggers, approve-once trigger, SECURITY DEFINER balance trigger (app can read, never write balances).
- API: `POST/GET /v1/cashier-sessions`, `GET /v1/cashier-sessions/:id`, `POST …/:id/movements|close|approve-variance`, `POST /v1/sales` (Idempotency-Key **required**), `GET /v1/sales`, `GET /v1/sales/:id`, `POST /v1/stock/adjustments`, `GET /v1/stock/balances|movements`.
- Tests (`sales.test.ts`, 19): full shift reconciles (lines→totals, tenders→due+change, drawer→due, stock→−qty, expected cash, zero-variance close); retry replays; 5 concurrent same-key → 1 sale; same clientTransactionId under new key → DUPLICATE_TRANSACTION; key required; 10 concurrent sales → numbers 1..10 and a failed sale consumes none; 5 failure modes leave no rows; stale total reports the new amount; beneficiary validation; one open session per register; not-owner/closed-session refusals; variance approval by another user, self-approval refused, approve once; branch scope; stock permissions, negative stock visible; append-only evidence and read-only balances.
- **Defect found & fixed:** intermittent "TAX_PROFILE_MISSING"/not-yet-priced right after setup. Root cause measured, not guessed: the Docker DB clock stepped back ≈0.9 s between transactions (later session `opened_at` < earlier profile `effective_from`). Fix: effective-date resolution allows 5 s skew (ADR-0009 §8), regression test added; 10/10 stress runs green (was ~1 in 3–8 failing).

### Phase 2 slice 3 — payments and receipts (session 3)
- ADR-0010. Migrations 0018/0019: `payment_intents` (trigger: PROCESSING → SUCCEEDED|FAILED|UNKNOWN; UNKNOWN → SUCCEEDED|FAILED; SUCCEEDED → CANCELED if unconsumed; consumed once; identity immutable), append-only `payment_events`; `sale_tenders` gains CARD/QR/EWALLET with `payment_intent_id` (unique, no change on electronic tenders).
- API: `POST /v1/payment-intents` (Idempotency-Key required, stored on the intent), `GET /v1/payment-intents?cashierSessionId=`, `GET /v1/payment-intents/:id` (with events), `POST …/:id/reconcile`, `POST …/:id/cancel`; `POST /v1/sales` accepts `{ method: 'INTENT', paymentIntentId }` tenders; `GET /v1/sales/:id/receipt`.
- `PAYMENT_PROVIDER=dev` only (production boot refuses it); `PAYMENT_TIMEOUT_MS` (default 15 s).
- Tests: 9 payment cases (split tender reconciles, card-only moves no cash, retry → same intent and 1 charge, decline, lost response → UNKNOWN → reconcile SUCCEEDED with 1 charge, never-received → FAILED, cancel, mismatch/overpayment/double tender leave no sale, owner-only + key required); receipt unit tests (never "official receipt", TIN with branch code, local time, VAT/non-VAT breakdowns, SC block) + API check; isolation +4 id routes, +3 smuggling cases, intents/events in the DB sweep.

### Phase 2 slice 4 — voids and returns (session 3)
- ADR-0011. Migrations 0020/0021: `sale_returns`, `sale_return_lines` (forced RLS, append-only, open-session trigger, within-sold trigger); `cash_movements` gains REFUND (negative, linked to the return); `stock_movements` gains RETURN (positive, linked to the return line) with direction checks.
- API: `POST /v1/sales/:id/returns` (Idempotency-Key required; VOID or RETURN), `GET /v1/sales/:id/returns`; sale view shows `returnedQuantity` per line.
- Tests (7): exact three-way proration + restock + drawer back to float; DAMAGED not restocked; SC return refunds what was paid; void once, only in its session; cashier forbidden, stale refund, insufficient drawer cash (nothing written); 4 concurrent returns of the last unit → exactly one; replayed void; append-only. Isolation: +2 id routes, +1 smuggling case, return tables in the DB sweep.

### Phase 2 slice 5 — reports (session 3)
- `GET /v1/reports/{sales-summary,by-product,by-cashier,by-tender,tax-summary,statutory-book}?branchId&from&to[&scheme]` and `GET /v1/reports/cashier-sessions/:id`. Sales count on completion, returns on processing, in the branch's local days; net = sales − returns.
- Tests (10): one realistic day (cash, SC, card, void, partial return) — every report matches hand-computed totals, cross-reconciles (Σ by-product = Σ by-tender = summary net = SQL over evidence tables; tax summary = summary buckets), SC book row with ID, session drawer = float + cash − refunds, local-date exclusion, access (cashier 403, other-branch manager 403, own session only), range validation. Defect fixed: document numbers were returned as strings (bigint) — now integers. Isolation: report endpoints in the attack/smuggle matrices and deep scan.

### Phase 2 slice 6 — POS browser checkout (session 3)
- `apps/pos-desktop` (React 19 + Vite 8 + Tailwind 4, @fontsource Archivo): full counter flow on the real API — sign-in, business, register picker, open shift, scan/search, server-priced cart, SC/PWD capture, cash/card/QR tenders, receipt, shift history with manager void/return, close with count. Browser-mode banner ("online only · no printer or drawer"); device ports per ADR-0006.
- API: `GET /v1/pos/workstations` (registers the user may run, with branch and own open shift; cashiers lack org.read so `/v1/registers` was unusable) — tested, in the isolation deep scan.
- E2E `pnpm test:e2e:pos`: **15/15** (₱78.40 cash sale with ₱21.60 change, receipt "THIS IS NOT AN OFFICIAL INVOICE" + VAT REG TIN + R1-000001; SC ₱16.50 → ₱11.78 by card with ID + signature block; ₱22.40 return refunded; drawer ₱1,056.00 balanced; no horizontal scroll at 1024/390; Filipino).
- Defects found by running it and fixed: receipt printed SC lines as "V" (now flagged by actual taxation: E, or V/E for a partial share — unit-tested); reopening a shift landed on the close tab; band overflowed at 390px.

## Verified in session 3 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **87 passed** (tax 27, api 22, money 15, config 6, validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **183 passed** — database 21, api **154** (sales+payments+returns+workstations 36, tax 18, reports 10, isolation 9, …), workers 8 |
| `pnpm test:e2e:pos` / `pnpm test:e2e:web` | **15/15** / **19/19** against live API |
| `pnpm test:e2e:web` | **19/19** against live API + `next start` |
| dev DB | migrated 0014/0015; backfill verified |

## User decisions (2026-10-15)
- **No GitHub remote yet** — keep the repo local; CI deferred. Don't create one until asked.
- **Payment provider: PayMongo** (Phase 2 payment adapter targets PayMongo; dev adapter until keys are provided).
- **Hosting: cloud** (specific provider/region still open — keep Docker images provider-neutral; OTel exporter choice waits on this).

## Verified in session 2 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` | ok, lint exit 0 |
| `pnpm test` | **55 passed** (money 15, config 6, validation 5, observability 5, workers 2, api 17 incl. OpenAPI drift check) |
| `pnpm test:integration` | **119 passed** — database **21** (14 + 7 schema guard), api **90** (77 + isolation 9 + logging 4), workers **8** |
| `pnpm test:e2e:web` | **19/19** against live API + `next start` |
| `node apps/admin-web/e2e/review.mjs` | **18/18** — 15 states × 1440/390 captured to `.impeccable/review/screens/`, no horizontal scroll at 390 anywhere |
| live boot | built API logs JSON access lines with correlation id; built worker delivered 31 queued events, each logged with origin `correlation_id` + `tenant_id` |

## Phase 1 exit review — what was checked and found
1. **Cross-tenant isolation**
   - `packages/database/test/integration/rls-catalog.test.ts` reads the system catalog: every table is tenant-keyed or allow-listed with a reason; ENABLE+FORCE RLS with only the canonical `tenant_id = app_current_tenant_id()` policy; `UNIQUE(tenant_id,id)` (reviewed leaf exceptions: audit_logs, idempotency_records, outbox_events, subscriptions — and a check that nothing references them); tenant→tenant FKs include `tenant_id`; runtime role owns nothing and has no TRUNCATE/TRIGGER/REFERENCES; SECURITY DEFINER functions owned by `onepos_platform`, pinned `search_path`, not PUBLIC-executable; `platform_set_subscription` not granted to the app. Mutation-tested with a deliberately unprotected table (3 tests fail as intended).
   - `apps/api/test/integration/isolation.test.ts`: two fully configured tenants; the attack matrix is asserted **equal to the live router's `:id` routes** (29 — a new id route without a case fails the suite) → all 404 NOT_FOUND; 16 body/query id-smuggling cases → 403/404; list/read endpoints deep-scanned for foreign ids; DB sweep driven by the catalog (fixture puts rows in every tenant table; runtime role in B's context sees/updates none of A's rows; WITH CHECK blocks foreign inserts; no context → no rows).
   - **Defect found & fixed:** `GET /v1/variants/:id/price-history` returned `200 []` for foreign/unknown variants (no data leak, but an inconsistent existence signal) → now 404.
   - Accepted by design: `audit_logs.tenant_id` NULL = platform-level event, visible to no tenant.
2. **OpenAPI**: `docs/api/openapi.json` (OpenAPI 3.1, 64 operations) generated from Nest route metadata + the same zod schemas the pipes use (`pnpm --filter @1pos/api openapi` after `pnpm build`). Documents bodies, queries, path ids, Idempotency-Key, rate limits, declared permissions and the error envelope. **Response bodies are not schema-typed yet.** Unit test fails on drift.
3. **Logging / OTel**: new `@1pos/observability` (pino JSON, redaction of credentials/tokens/cookies, AsyncLocalStorage context, `trace_id`/`span_id` mixed in when an OTel SDK is active). API: access log per request (route pattern, status, duration — never query/body/headers); tenant id added only after membership re-check. Worker: per-event scope with origin correlation + tenant id. `LOG_LEVEL` env. **No OTel SDK/exporter installed yet** (waits on hosting choice).
4. **Admin screens**: new `e2e/review.mjs` (shared CDP harness `e2e/cdp.mjs`). Findings fixed: raw zod messages ("Too small: expected string…") shown to users → API now sends issue `code`+bounds and the web translates (EN/FIL); single-choice selects labelled in plural; **₱ rendered as "P" at 13–15px** (Archivo's hairline bars) → U+20B1 now drawn from a system face via `unicode-range`. Also fixed a race in `smoke.mjs` (TIN hint text satisfied the wait before the POST). Not fixed (logged in BACKLOG): tables at 390px scroll inside their container so trailing columns/actions start off-screen; some FIL strings still English (enum labels like "VAT-registered").

## Carried forward from Phase 1 (non-blocking for Phase 2)
MFA (TOTP) for privileged roles · password reset (needs real email adapter) · Redis rate limiter (in-memory now; single instance only) · real email provider · OTel SDK + exporter · typed response schemas in OpenAPI · `onepos_worker` DB role · admin UI: product edit/variants, custom-role editor, member role editing, price-list create · Filipino copy native review · CI (needs remote). Lockout reveals account existence via 429 (accepted). Node `crypto.argon2` still experimental in Node.

## Next task (start here)
1. Commit if not yet committed (`git status`).
2. **Phase 6** (ADR-0016). Slices 1–6 and 8 are done (8 in session 13). Slice 7 (deployment) needs D1/D3; slice 9 needs D4–D6. With no decision made, the next work needing none is in LEFTOVER.md:
   - slice 8 privacy gaps: purge jobs (sessions, reset tokens, invitations, outbox) once the DPO confirms the periods, log redaction of personal fields with a test, account closure, profile edit, an audited account-disable command;
   - slice 5 performance items.
   - The privacy pack (`docs/compliance/privacy/`) needs the user's DPO to review it (release gate G6).
   - Slice 6 leftovers (LEFTOVER.md): first-sale walkthrough, anonymisation job, object storage (D1), per-request support audit volume, the long-business-name band clip, the flaky `reliability.test.ts` outbox ordering.
   - `test:e2e:desktop` was not run in sessions 10–13; run it with the next till change.
   - Decisions for the user (ADR-0016):
     - **D1** hosting provider and region;
     - **D2** email provider (password reset, invitations and the production boot wait on it);
     - **D4** pilot businesses and pilot length;
     - **D5** invoicing during the pilot (tax adviser);
     - **D6** PayMongo keys.
     - D3: no git remote yet (user, 2026-10-15), so CI stays deferred.
3. **Phase 5** ✅ exit met for offline cash sales (session 8). Deferred Phase 5 items:
   - **Slice 6 — PayMongo**: the user said they will put the sandbox keys in `.env` (`PAYMONGO_SECRET_KEY`, `PAYMONGO_PUBLIC_KEY`, `PAYMONGO_WEBHOOK_SECRET`; never in chat). At session end they were not set yet. Check with `grep -c '^PAYMONGO_SECRET_KEY=sk_test_' .env`. Then build the adapter behind `PaymentProvider` (ADR-0010) with webhooks and card/QR refunds, and add `paymongo` to `PAYMENT_PROVIDER`.
   - Slice 7: exit review. Run every E2E suite incl. `test:e2e:desktop`, and drill the till on real printer/drawer hardware if the user has it.
   - Desktop leftovers (ADR-0015 "Known gaps (desktop)"): offline sign-in after a restart (PIN), signed installer + auto-update, real printer/drawer check.
4. Decisions for the user:
   - whether a service charge's stored gross should include its VAT (LEFTOVER.md, Phase 4 slice 7).
5. Carried, non-blocking: the tax adviser's and accountant's answers (service charge; ADR-0013 questions 1–10); all phase/slice leftovers now live in `docs/LEFTOVER.md` (moved out of BACKLOG 2026-10-17).
Carried (non-blocking): supplier invoices/AP + input VAT; low-stock push alerts; blind counts; admin UI for tax profiles; SC/PWD professional sign-off (gate #6); PayMongo adapter + card/QR refunds + provider fees/settlement; Z-reading/fiscal gate G2; CSP header for POS hosting; POS phone sticky total bar; shift-history tender/void tags.
