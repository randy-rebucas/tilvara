# 1POS — Leftovers (open items from finished slices and phases)

Moved out of `docs/BACKLOG.md` on 2026-10-17. BACKLOG keeps the plan (phases, slices, exits); this file keeps what each finished slice left open. Legend: ⬜ open · ⏳ waiting on a user decision (D1–D6) or an outside reviewer. Remove an item when it is done, or move it back into a BACKLOG slice when it is scheduled.

## Phase 0 — Repository & architecture
- ⬜ CI pipeline (GitHub Actions: install, lint, typecheck, unit, integration with Postgres service) — needs a remote repo decision (D3)

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
- ⬜ Invoice-level rounding option

Slice 3 (payments):
- ⏳ PayMongo adapter + webhooks (needs sandbox keys) — D6

Slice 4 (voids/returns):
- ⬜ Refunds to card/QR (needs PayMongo)
- ⬜ Cross-branch returns

Slice 5 (reports):
- ⬜ Z-reading with accumulated grand total (fiscal gate G2)
- ⬜ PDF export of reports (CSV download exists for every report since session 10)

Slice 6 (POS browser checkout):
- ⬜ CSP response header in production hosting
- ⬜ Customer display
- ⬜ Barcode scale codes

Phase-level:
- ⬜ `@1pos/pricing` promotions
- ⬜ Invoice sequences (dev series only today)
- ⬜ Negative-stock policy (BLOCK/ALLOW_WITH_FLAG) — today sales may go negative and it stays visible
- ⬜ A test for one session spanning local midnight (needs clock control)

## Phase 3 — Inventory, purchasing, accounting
Slice 5 (admin UI):
- ⏳ Accountant review answers (ADR-0013 questions 1–10)

Phase-level:
- ⬜ Supplier invoices + accounts payable (GRNI → AP, input VAT)
- ⬜ Low-stock push alerts (outbox event when crossing the reorder point)
- ⬜ Blind counts (freeze + post later)
- ⬜ UoM conversions and purchase units
- ⬜ Batch/expiry and serial tracking
- ⬜ Landed cost
- ⬜ Financial exports beyond the journal CSV (e.g. a ready-made import for a given accounting package)
- ⏳ Accountant review of the default chart and posting policies

## Phase 4 — Restaurant
Slice 2 (menu foundation):
- ⬜ The POS menu view prices item by item (N queries) — batch it if menus get large (Phase 6 slice 5)
- ⬜ Modifier groups are live configuration: edits to min/max apply to published menus immediately (orders snapshot what was chosen)

Slice 3 (orders + kitchen):
- ⬜ KDS push (SSE) instead of polling
- ⬜ Per-seat views and "fire course N" reminders/timers
- ⬜ Kitchen printers (device adapters)
- ⬜ Voiding a modifier alone (today: void the item and re-add)
- ⬜ Reprint/recall a ticket
- ⬜ Order notes per course

Slice 4 (bills + checks + service charge):
- ⬜ Card/QR checks use the existing intent flow, but no POS UI yet
- ⬜ Tips
- ⬜ A bill as PDF (the till prints and reprints the bill since session 10)
- ⬜ Adding items after a partial payment (today: a new order once the bill settles)
- ⬜ Returns still prorate each bucket on its own (ADR-0011), unlike checks' residual-bucket proration; align if odd cents show up on partial returns

Slice 5 (restaurant reports):
- ⬜ Prep times by hour or day part and per item
- ⬜ Open orders: items as they were at the cutoff (today: as attached now)
- ⬜ Free modifiers ("no onions") counts in item performance (no sale line today)
- ⏳ The DOLE distributable base (ex VAT) is pending the accountant (ADR-0014 §9)

Slice 6 (UI):
- 6a POS table service:
  - ⬜ Servers without a drawer (today the Tables tab lives inside a register shift)
  - ⬜ Floor positions/shapes on a drawn plan (tiles today)
- 6b KDS:
  - ⬜ Un-bump a ticket (the Done view shows finished tickets read-only since session 10)
  - ⬜ Push (SSE) instead of polling
- 6c admin set-up:
  - ⬜ Drag-and-drop ordering (buttons today)
  - ⬜ A plan view of the floor (positions/shapes are stored, tiles today)
- 6d report screens:
  - ⬜ PDF export (CSV and date presets are done)

Slice 7 (exit review):
- ⬜ `sales.gross` counts a service charge ex VAT while item lines count VAT-inclusive; the receipt adds the charge VAT back, but any other consumer of `gross` (exports, a future invoice) must do the same — decide whether to store a charge's gross with VAT
- ⬜ No drill for an API restart between a check's commit and its answer (covered generically by the Phase 2 restart drill and the same idempotency path)
- ⬜ The "void vs bill" drill asserts both outcomes but cannot force each interleaving

Out of scope for Phase 4 (later):
- ⬜ Delivery orders; unit conversions/purchase units for recipes; sub-recipes/prep production; rule-based modifier pricing; tips; reservations; KDS push (SSE) and kitchen printers

Open questions for the tax adviser and the accountant:
- ⏳ Service charge base and VAT; SC/PWD share of the service charge; service charge as a liability

## Phase 5 — Offline & integrations
Slice 6 (deferred by the user's decision):
- ⏳ PayMongo adapter + webhooks (env settings done session 8; waiting for sandbox keys in `.env`) — D6
- ⏳ Invoice transmission (compliance gate)

Slice 7 (exit review):
- ⬜ Not drilled: `PERIOD_CLOSED` for an offline sale (needs month-old fixtures)

Phase-level:
- ⬜ Recovering a revoked terminal's queue (admin tool)
- ⬜ Device sequence restarts if the till's file is lost
- ⬜ Desktop: offline sign-in after a restart during an outage (PIN for the shift's cashier)
- ⬜ Desktop: signed NSIS installer + auto-update
- ⬜ Desktop: serial/COM printers without a Windows driver
- ⬜ Desktop: real printer/drawer hardware check
- ⬜ Offline SC/PWD and discounts (refused offline today)
- ⬜ Opening a shift offline
- ✅ Snapshot paging for large catalogues (Phase 6 slice 5, session 11)
- ⬜ Push the snapshot when prices change (today: the till refreshes when online)
- ⬜ Printer status (paper out, cover open) needs the device's status bytes (DLE EOT) through the shell
- ⬜ Receipt logo/QR images (ESC/POS raster) when a design asks for them

## Phase 6 — Pilot readiness
Slice 1 (account security):
- ⬜ Time-limited, tenant-approved support access (slice 6); MFA reset itself is done (owner/admin on the member page; owners by the support CLI with a ticket)
- ⬜ Nonce-based CSP for the admin; CSP for POS browser hosting
- ⬜ WebAuthn/passkeys

Slice 2 (platform hardening):
- ⬜ Accepted dev-only advisory: esbuild ≤ 0.24.2 in drizzle-kit (re-check when drizzle-kit updates)
- ⬜ The bundle scan does not cover server-rendered admin pages
- ⏳ Run the security gates automatically (needs CI, D3)
- ⬜ T5 refund approval thresholds / anomaly report (product backlog)

Slice 3 (monitoring):
- ✅ Backup-age metric and alert (slice 4, session 11)
- ⬜ Billing failure metrics (no billing integration yet, D6)
- ⏳ OTel traces/exporter — D1
- ⬜ No authentication on the metrics port: relies on network placement (slice 7)
- ⬜ DEAD letters are a CLI only; no admin/support screen (slice 6)

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
- ⬜ With one saturated instance a till's sync still got no answer 3 times: the request can wait up to 5 s for a pool connection before the 8 s budget starts. Count the budget from request arrival, or make sync a priority queue.
- ⬜ `pg` deprecation: "client.query() when the client is already executing a query". Some code runs queries concurrently on one transaction's client (`Promise.all` inside `withTenant`); pg@9 will refuse it. Find and serialize.
- ⬜ Fewer statements per request: a lookup is 14 (auth context + 5 sequential reads), a 3-line checkout 47. Merge the lookup reads; cache the auth context per token for a few seconds.
- ⬜ `platform_metrics()` takes ~90 ms on the load DB (100k items, a few thousand sales); watch it as data grows (alert `OneposBusinessGaugesSlow`).
- ⬜ `monitoring.test.ts` "is its own listener" failed once right after the offline drills in the same run (`onepos_db_up` not yet 1 on the first scrape); it passed alone and in the final full gate. Watch it.
- ⬜ `onepos_test` grows with every integration run (564 MB on 2026-10-18), and the suites slow down with it. Consider dropping and recreating it at the start of the gate (it is migrated automatically).

The remaining Phase 6 slices ( 6 onboarding/support, 7 deployment, 8 runbooks/privacy, 9 UAT/pilot) are planned in BACKLOG.md. Decisions waiting on the user: D1 hosting provider/region, D2 email provider, D4 pilot businesses, D5 invoicing during the pilot (tax adviser), D6 PayMongo keys.
