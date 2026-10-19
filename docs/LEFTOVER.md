# Tilvara — Leftovers (open items from finished slices and phases)

Moved out of `docs/BACKLOG.md` on 2026-10-17. BACKLOG keeps the plan (phases, slices, exits); this file keeps what each finished slice left open. Legend: ⬜ open · ⏳ waiting on a user decision (D1–D6) or an outside reviewer. Remove an item when it is done, or move it back into a BACKLOG slice when it is scheduled.

## Brand: renamed 1POS → Tilvara (2026-10-18)
Every name people see was renamed: copy (EN and FIL), titles, emails, receipts, the TOTP issuer, the OpenAPI title, the Tauri product name, CSV filenames, and the docs. These were kept on purpose:
- Kept forever, because renaming them breaks data already out there: the JWT `iss`/`aud` (`1pos-api`/`1pos`, would sign everyone out), the recovery-code and MFA-key derivation salts (`1pos-recovery:`, `1pos-mfa`, would invalidate codes and secrets), the till keychain service `"1POS till"` and the Tauri identifier `ph.onepos.till` (tills would lose their saved credential and local SQLite data).
- Renameable later, as a separate slice: the `@1pos/*` package scope, the `onepos_*` DB roles and DB names (these appear in migrations that are already applied, so this needs new migrations plus `01-roles.sql` and a dev-volume upgrade script), the `x-onepos-request` CSRF header, the `Onepos*` alert names, the compose project, the cargo crate and exe name `onepos-till`, and the localStorage keys.
- ⏳ Trademark and domain clearance for "Tilvara" (WIPO, IPOPHL classes 9/42, `.com`/`.ph`) before any public launch; `api.1pos.ph` in `desktop.test.ts` is only an example host.

## Phase 0 — Repository & architecture
- ⏳ CI: `.github/workflows/ci.yml` is written (session 16) but has never run; it needs the remote repository (D3). Expect to adjust it on its first run

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
- ⬜ `@1pos/pricing` promotions
- ⬜ Invoice sequences (dev series only today)

## Phase 3 — Inventory, purchasing, accounting
Slice 5 (admin UI):
- ⏳ Accountant review answers (ADR-0013 questions 1–10)

Phase-level:
- ⬜ Supplier invoices + accounts payable (GRNI → AP, input VAT)
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
- ⬜ Kitchen printers (device adapters)
- ⬜ Reprint a ticket (needs kitchen printers; recalling finished tickets is the KDS Done view since session 10)
- ⬜ Floor push (session 16) at deployment (slice 7): the edge proxy must not buffer `text/event-stream` (`/v1/restaurant/stream`; the API sends `X-Accel-Buffering: no`) and must allow a 10-minute response; open streams are not yet a metric

Slice 4 (bills + checks + service charge):
- ⬜ Tips
- ⬜ Adding items after a partial payment (today: a new order once the bill settles)
- ⬜ Returns still prorate each bucket on its own (ADR-0011), unlike checks' residual-bucket proration; align if odd cents show up on partial returns

Slice 5 (restaurant reports):
- ⬜ Free modifiers ("no onions") counts in item performance (no sale line today). Needs a rule for when a free choice counts as sold (fired, billed or paid), so it is left for the restaurant reporting review
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
- ⬜ Delivery orders; unit conversions/purchase units for recipes; sub-recipes/prep production; rule-based modifier pricing; tips; reservations; kitchen printers

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
