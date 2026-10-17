# 1POS — Leftovers (open items from finished slices and phases)

Moved out of `docs/BACKLOG.md` on 2026-10-17. BACKLOG keeps the plan (phases, slices, exits); this file keeps what each finished slice left open. Legend: ⬜ open · ⏳ waiting on a user decision (D1–D6) or an outside reviewer. Remove an item when it is done, or move it back into a BACKLOG slice when it is scheduled.

## Phase 0 — Repository & architecture
- ⬜ CI pipeline (GitHub Actions: install, lint, typecheck, unit, integration with Postgres service) — needs a remote repo decision (D3)

## Phase 1 — Platform foundation
- ⏳ Real email provider (prod boot refuses the dev mailer; invitations and password reset use DevMailer) — D2
- ⬜ Catalog: bundles/composites; product images (needs S3 adapter); batch/expiry & serial tracking and UoM conversions (see Phase 3)
- ⏳ Billing: PayMongo billing integration (grant `platform_set_subscription` to it) — D6; feature flags enforced once restaurant/multi-entity features exist; per-tenant entitlement overrides
- ⬜ Audit viewer UI (planned in Phase 6 slice 6)
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
- ⬜ Receipt for return documents

Slice 5 (reports):
- ⬜ Z-reading with accumulated grand total (fiscal gate G2)
- ⬜ Exports (CSV/PDF)
- ⬜ Retail report UI (see Phase 4 6d)

Slice 6 (POS browser checkout):
- ⬜ CSP response header in production hosting
- ⬜ Keyboard shortcuts (F-keys)
- ⬜ Customer display
- ⬜ Barcode scale codes

Phase-level:
- ⬜ `@1pos/pricing` promotions
- ⬜ Invoice sequences (dev series only today)
- ⬜ Negative-stock policy (BLOCK/ALLOW_WITH_FLAG) — today sales may go negative and it stays visible
- ⬜ POS phone layout: sticky total + Pay bar
- ⬜ Shift history: tender + voided/returned tags
- ⬜ A test for one session spanning local midnight (needs clock control)

## Phase 3 — Inventory, purchasing, accounting
Slice 5 (admin UI):
- ⏳ Accountant review answers (ADR-0013 questions 1–10)
- ⬜ A list of all supplier returns per branch (each is reachable from its receipt and the journal today)

Phase-level:
- ⬜ Supplier invoices + accounts payable (GRNI → AP, input VAT)
- ⬜ Low-stock push alerts (outbox event when crossing the reorder point)
- ⬜ Blind counts (freeze + post later)
- ⬜ UoM conversions and purchase units
- ⬜ Batch/expiry and serial tracking
- ⬜ Landed cost
- ⬜ Financial exports (CSV/journal export)
- ⏳ Accountant review of the default chart and posting policies

## Phase 4 — Restaurant
Slice 2 (menu foundation):
- ⬜ The built-in `branch_manager` lacks `restaurant.manage` (only owner/admin set up restaurants): add a "restaurant manager" role template or grant it to branch managers
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
- ⬜ A bill print/PDF
- ⬜ Per-seat split helper (today: allocate the seat's lines)
- ⬜ Adding items after a partial payment (today: a new order once the bill settles)
- ⬜ Returns still prorate each bucket on its own (ADR-0011), unlike checks' residual-bucket proration; align if odd cents show up on partial returns

Slice 5 (restaurant reports):
- ⬜ CSV export
- ⬜ Prep times by hour or day part and per item
- ⬜ Open orders: items as they were at the cutoff (today: as attached now)
- ⬜ Free modifiers ("no onions") counts in item performance (no sale line today)
- ⏳ The DOLE distributable base (ex VAT) is pending the accountant (ADR-0014 §9)

Slice 6 (UI):
- 6a POS table service:
  - ⬜ Merge / move items between orders in the UI (API done)
  - ⬜ Per-seat split helper
  - ⬜ Reprint a bill
  - ⬜ Servers without a drawer (today the Tables tab lives inside a register shift)
  - ⬜ Floor positions/shapes on a drawn plan (tiles today)
- 6b KDS:
  - ⬜ Sound/flash on a new ticket
  - ⬜ Recall bumped tickets (`status=ALL` exists)
  - ⬜ No built-in "kitchen crew" role template (custom role today; decide with the restaurant-manager template question)
  - ⬜ Push (SSE) instead of polling
- 6c admin set-up:
  - ⬜ Drag-and-drop ordering (buttons today)
  - ⬜ A plan view of the floor (positions/shapes are stored, tiles today)
- 6d report screens:
  - ⬜ The retail reports (summary, by product, cashier, tender, tax, SC/PWD book) on the same `/reports` frame
  - ⬜ CSV/PDF export
  - ⬜ Date presets (this week, last month, pay period)

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
- ⬜ Snapshot paging for large catalogues (Phase 6 slice 5)
- ⬜ Push the snapshot when prices change (today: the till refreshes when online)
- ⬜ Printer status (paper out, cover open) needs the device's status bytes (DLE EOT) through the shell
- ⬜ Receipt logo/QR images (ESC/POS raster) when a design asks for them

## Phase 6 — Pilot readiness
Slice 1 (account security):
- ⬜ Support "reset a member's MFA" (slice 6) — needed before the pilot so a lost phone is not a lockout
- ⬜ Nonce-based CSP for the admin; CSP for POS browser hosting
- ⬜ WebAuthn/passkeys

Slice 2 (platform hardening):
- ⬜ Accepted dev-only advisory: esbuild ≤ 0.24.2 in drizzle-kit (re-check when drizzle-kit updates)
- ⬜ The bundle scan does not cover server-rendered admin pages
- ⏳ Run the security gates automatically (needs CI, D3)
- ⬜ T5 refund approval thresholds / anomaly report (product backlog)

Slice 3 (monitoring):
- ⬜ Backup-age metric and alert (slice 4)
- ⬜ Billing failure metrics (no billing integration yet, D6)
- ⏳ OTel traces/exporter — D1
- ⬜ No authentication on the metrics port: relies on network placement (slice 7)
- ⬜ DEAD letters are a CLI only; no admin/support screen (slice 6)

⬜ Slice 4 — backup and restore: encrypted `pg_dump` + manifest, automated restore drill (`pnpm drill:restore`: roles, RLS, counts, audit, API smoke), RTO measured, backup-age metric. PITR waits on D1.
⬜ Slice 5 — performance: pilot-scale seed, Node load harness (checkout/lookup/sync/reports p50/95/99, zero duplicates), fixes (POS menu N+1, snapshot paging).
⬜ Slice 6 — onboarding and support: audit log reader + screen; tenant-approved, time-limited support access; MFA reset by support; tenant data export (ZIP of CSVs, signed link); offboarding runbook; sample data for trials.
⬜ Slice 7 — deployment (needs D1, D3): Dockerfiles, container scan, CI, staging, secrets manager, migration procedure.
⬜ Slice 8 — runbooks + privacy pack (drafts for the DPO, not legal advice).
⬜ Slice 9 — UAT scripts, compliance release review, pilot runbook + daily reconciliation report (needs D4–D6).
Decisions waiting on the user: D1 hosting provider/region, D2 email provider, D4 pilot businesses, D5 invoicing during the pilot (tax adviser), D6 PayMongo keys.

## Phase 7 — Differentiation (validated demand only)
Ecommerce, loyalty, forecasting, replenishment, loss-prevention analytics, multi-branch intelligence.