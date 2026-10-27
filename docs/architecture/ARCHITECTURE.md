# Tilvara — Architecture

Status: Phase 0 baseline (2026-10-15). Living document — update it when the implementation diverges.

## 1. Assessment of the starting point

- Repository: **empty** at start (greenfield, initialised 2026-10-15 at `~/projects/1pos`).
- Tooling available on the dev machine: Node 24.12, pnpm 10.33, Docker 29, psql 16 client, git 2.51.
- Rust/cargo was not available at the start; it was installed in session 8 and the Tauri 2 desktop shell is built (`apps/pos-desktop/src-tauri`, ADR-0006, ADR-0015).
- No external credentials (payment providers, BIR EIS, SMTP, S3). Every such integration starts as an adapter interface plus a clearly labelled `Dev*` implementation.

## 2. Architectural style

**Modular monolith** (ADR-0001). One NestJS API process and one worker process, both built from the same domain modules, sharing one PostgreSQL database. Modules communicate through explicit service interfaces and domain events written to a transactional outbox — never by reaching into each other's tables.

```
                ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
                │  admin-web   │     │ pos-desktop  │     │ mobile (later)│
                │  Next.js     │     │ React(+Tauri)│     │ Expo          │
                └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
                       │ HTTPS /v1 REST     │ HTTPS /v1 + sync    │
                       ▼                    ▼                     ▼
               ┌────────────────────────────────────────────────────────┐
               │                    apps/api (NestJS)                   │
               │  auth · tenancy · catalog · pricing · tax · checkout   │
               │  payments · invoicing · inventory · purchasing ·       │
               │  cash · accounting · customers · reports               │
               │  sync · integrations · platform-admin · audit          │
               └───────────────┬───────────────────────┬────────────────┘
                               │ SQL (RLS, tx-scoped   │ outbox rows
                               │ tenant context)       ▼
                       ┌───────▼────────┐      ┌───────────────┐
                       │  PostgreSQL 18 │◄─────│ apps/workers  │──► payment / EIS /
                       │  (single DB,   │      │ (outbox relay,│    notification
                       │  shared schema)│      │ reconciliation│    adapters
                       └────────────────┘      │ reports)      │
                                               └───────┬───────┘
                       ┌────────────────┐              │
                       │ Redis 7        │◄─────────────┘ rate limits, caches,
                       └────────────────┘                short-lived locks only
```

Redis holds **nothing that must survive** — durable state (jobs, idempotency, outbox) lives in Postgres (ADR-0003).

## 3. Business hierarchy

`Platform → Tenant → Legal Entity → Branch → Register/Terminal → Cashier Session`

- **Tenant**: the SaaS customer account (subscription, users, configuration).
- **Legal entity**: a taxpayer (TIN, registered name, VAT status, invoicing registration). A tenant may have several. The subscription owner is *not* assumed to be the invoice issuer.
- **Branch**: a physical/operational location belonging to exactly one legal entity (BIR branch code lives here). Inventory locations hang off branches.
- **Register**: a logical till (invoice series, cash drawer). **Terminal**: a registered physical device with its own credential, currently bound to at most one register.
- **Cashier session**: an open period on a register for one cashier, with opening float and closing count.

## 4. Module map and dependency rules

```
apps/
  api/            NestJS composition root: HTTP controllers, guards, module wiring
  workers/        outbox relay, reconciliation, report jobs (same modules, no HTTP)   [Phase 1+]
  admin-web/      Next.js App Router back office                                      [Phase 1]
  pos-desktop/    React POS: browser mode, and a Tauri 2 shell (src-tauri; SQLite through one rusqlite connection) [Phase 2/5 — built]
  mobile/         Expo, only when justified                                            [Phase 6+]
packages/
  money/          exact decimal Money/Quantity, allocation, rounding  (pure, no deps but decimal.js)
  config/         env schema + validation (pure)
  database/       Drizzle schema, migrations, tenant-scoped transaction helper
  tax/            versioned tax rules, PH VAT / SC-PWD computations (pure)             [Phase 2 — built]
  pricing/        promotions (`applyPromotions`, pure; ADR-0021)                       [built]
  accounting/     posting rules, balance validation, default chart (pure)              [Phase 3 — built]
  sync-protocol/  offline envelope, snapshot and result types shared by POS and API    [Phase 5 — built]
  pos-offline/    the till's offline engine: SQLite store, durable queue, sync (no React) [Phase 5 — built]
  validation/     zod request/response contracts shared with clients                     [Phase 1 — built]
  escpos/         ESC/POS receipt rendering for the till's printer                       [built]
  observability/  structured logging (`createLogger`, log context, redaction)            [built]
```

Stock costing lives in the stock-ledger trigger (ADR-0012), so there is no inventory package.

Packages are created **when first needed**, not as empty shells.

Dependency rules (enforced by review now, by lint rule later):
1. Pure calculation packages (`money`, `tax`, `pricing`, `accounting`) never import `database`, Nest, or I/O.
2. `apps/*` may depend on `packages/*`; packages never depend on apps.
3. Inside `apps/api`, a module may call another module only through that module's exported service. Cross-module table access is forbidden.
4. Clients (`admin-web`, `pos-desktop`) depend only on `validation`, `money`, `tax`, `pricing`, `escpos`, `sync-protocol`, `pos-offline` — never on `database`.

## 5. Core technical decisions (summary — see `docs/decisions/`)

| # | Decision | Choice |
|---|---|---|
| 0001 | Architecture style | Modular monolith, pnpm + Turborepo monorepo |
| 0002 | ORM / migrations | Drizzle ORM + drizzle-kit SQL migrations; hand-written SQL migrations for RLS, triggers, grants |
| 0003 | Background jobs | Postgres transactional outbox + `FOR UPDATE SKIP LOCKED` worker; no Redis-backed queue |
| 0004 | Tenant isolation | Shared schema, `tenant_id` everywhere, composite FKs, RLS forced, tx-scoped `set_config('app.tenant_id', …, true)` |
| 0005 | Identifiers & money | UUIDv7 (`uuidv7()` in PG18); NUMERIC(20,4) money, NUMERIC(18,4) qty; decimal.js in TS; strings on the wire |
| 0006 | POS client | React + Vite app first; Tauri + SQLite shell in Phase 5 once Rust toolchain installed |
| 0007 | Auth | Own auth (argon2id, short JWT access + rotating opaque refresh tokens, TOTP MFA for privileged roles) |
| 0008 | Tax engine | Pure `@1pos/tax`; seller = versioned `tax_profiles`, item = tax category, buyer = SC/PWD schemes; per-line centavo rounding; snapshots |
| 0009 | Checkout, cash, stock | One transaction per sale (`POST /v1/sales`), required Idempotency-Key + client transaction id, append-only cash/stock ledgers |
| 0010 | Non-cash payments | Payment intents: commit → provider call outside any tx → settle; timeouts become UNKNOWN and are reconciled, never re-charged |
| 0011 | Voids/returns | Append-only return documents with exact proration; cash refunds only until the PayMongo adapter |
| 0012 | Inventory costing | Weighted average per branch × item, computed by the ledger trigger under the balance lock; Σ movement value = balance value |
| 0013 | Double-entry ledger | Books per legal entity; every operational document posts one balanced entry in its own transaction; periods, reversals, manual entries |
| 0014 | Restaurant | **Withdrawn 2026-10-25** (migrations 0111, 0112; recipes too). Was: orders, checks, recipes consumed at checkout |
| 0015 | Offline sync | Terminal-authenticated snapshot + sync; offline cash sales re-priced as of the snapshot and recorded once; quarantine for managers |
| 0016 | Pilot readiness | Account security, rate limits, monitoring, backups and restore drills, load tests, onboarding, support access, data export |
| 0017 | Counter controls | Line discounts, price overrides approved by a second person, held carts, exchanges |
| 0018 | Customers | Customers, marketing consent events, store credit per legal entity |
| 0019 | API keys, webhooks | GET-only API keys with scopes; outbound webhooks carrying ids only, delivered by the worker |
| 0020 | Packs and expiry | Packs and pieces opened at the sale, expiry lots drawn first-expiry-first, alerts, write-offs (§1 GROCERY type withdrawn 2026-10-25) |
| 0021 | Promotions, shelves | `@1pos/pricing` promotions on both sides, sizes and colours, quick keys, labels, shelf locations |
| 0022 | Salons | **Withdrawn 2026-10-25** (migration 0112) |
| 0023 | Lodging | **Withdrawn 2026-10-25** (migration 0111) |
| 0024 | Laundry | **Withdrawn 2026-10-25** (migration 0110) |
| 0025 | Pharmacies | **Withdrawn 2026-10-25** (migration 0112), except §4 expired-stock rule, §5 lot codes, holds and batch trace, §7 box → strip → piece, kept for every shop |
| 0026 | Extensions | Retail is the base; industry modules (manifest + catalog row + plan allowance) switched on per business by the owner; `@RequiresExtension` / `assertExtension`; checklist `docs/architecture/extensions.md` |

## 6. Transaction engine (checkout) — as built (Phase 2)

The early design sketched a persisted `checkout_intents` state machine. What was built is simpler and keeps the same guarantees (ADR-0009/0010/0011):

```
cart ──POST /v1/tax/quote──► server price + tax (read only, repeatable)
card/QR ──POST /v1/payment-intents──► tx#1 PROCESSING → provider call (no tx, timeout) → tx#2 SUCCEEDED | FAILED | UNKNOWN
                                                              UNKNOWN ──reconcile──► SUCCEEDED | FAILED
sale ──POST /v1/sales──► one tx: lock session → recompute (TaxService.computeCart) → lock + consume intents
                         → number → sale, lines, tenders, cash + stock movements, audit, outbox, idempotency record
```

1. The request carries a required `Idempotency-Key` and a `clientTransactionId` generated on the counter; the cashier session is locked and must be the caller's own and `OPEN`.
2. Prices and taxes are recomputed from the versions in force (DB clock); the client's `expectedAmountDue` is only compared — a mismatch is `409 TOTAL_CHANGED` with the new amount.
3. Non-cash tenders are SUCCEEDED, unconsumed intents of the same session and client transaction, applied first; cash covers the rest and gives change.
4. Everything for the sale is written in that one transaction or not at all. The idempotency record is written in the same transaction, so a retry with the same key replays the original response; the same `clientTransactionId` under a new key is `409 DUPLICATE_TRANSACTION` with `details.saleId`, so the counter shows the recorded sale instead of ringing it again.
5. A database that is unreachable, drops the connection, times out a statement or aborts for serialization/deadlock answers **503 `SERVICE_UNAVAILABLE`** with `Retry-After` (never a bare 500): the counter retries with the same key. Checked-out and idle pool connections that die are discarded, never crash the process.
6. A shift cannot close while any of its card/QR payments is PROCESSING, UNKNOWN or SUCCEEDED-but-unconsumed (`409 PAYMENTS_OUTSTANDING`, ADR-0010 §6): no charge is left without a sale.
7. Refunds, voids and returns are **new documents** linked to the original sale lines; nothing posted is updated in place. Journal entries and invoice numbering are Phase 3 / compliance-gated.

The failure behaviour is drilled in `apps/api/test/integration/failure-drills.test.ts` (API restart, connection killed mid-checkout, DB unreachable, idle connections dropped, provider timeout, duplicate submits) and the end-to-end evidence chain in `reconciliation.test.ts`.

## 7. Inventory and books (as built, Phase 3)

Authoritative history = `stock_movements` (append-only). A `BEFORE INSERT` trigger owned by `onepos_platform` locks the item's `stock_balances` row, costs the movement (weighted average, ADR-0012) and updates quantity, value and average — the app role can read balances but never write them. Movement types and their source documents: `SALE`/`RETURN` (sale lines), `RECEIPT` (goods receipt lines), `SUPPLIER_RETURN`, `TRANSFER_OUT`/`TRANSFER_IN` (transfer lines), `COUNT` (count lines; quantity computed by the trigger), `ADJUSTMENT`, `WASTE`, `UNPACK_OUT`/`UNPACK_IN` (pack openings, ADR-0020). Multi-item documents insert in variant order (no deadlocks). The negative-stock policy is per branch (`ALLOW`, `ALLOW_WITH_FLAG`, `BLOCK` refusing counter sales); the trigger marks movements that go below zero and writes `stock.low` / `stock.below_zero` outbox events on the crossing. Count sheets freeze on hand, are counted (blind) and post each line against the book when it was counted: frozen + what moved after the freeze (numbered by the trigger, `balance_seq`) and by then (ADR-0012 amendment 3).

Purchasing: suppliers → purchase orders (DRAFT → APPROVED → PARTIALLY_RECEIVED → RECEIVED → CLOSED / CANCELLED; stock never moves on an order) → goods receipts (accepted vs rejected, never above what was ordered) → supplier returns.

Every operational document also posts one balanced journal entry in the same transaction (ADR-0013), so stock value, cash, VAT and revenue in the books always equal their evidence tables (`ledger.test.ts`).

## 8. Offline-first POS (Phase 5 — server, engine and Tauri desktop shell built)

```
till (OfflineEngine, SQLite)                         API
  refreshSnapshot ──GET /v1/terminal/snapshot──────► terminal credential → snapshot recorded (as_of = DB now)
  ringUp: price with @1pos/tax from the snapshot,
          one local tx: next deviceSeq + sale + envelope (nothing sent)
  syncOnce ──POST /v1/sync/sales (≤ 50, seq order)──► per envelope, own tx: dedupe (terminal, txn id, payload hash)
          ◄── RECORDED | QUARANTINED | DISMISSED |    → re-price as of the snapshot → record() as the shift's cashier
              REJECTED per envelope                     (device time, flags) | quarantine for a manager
  no answer / 5xx / 429 → back off, same envelopes;  401 → stop (revoked)
```

- Offline: cash retail sales only, on a shift opened online, by its cashier (ADR-0015 §1). Card/e-wallet are unavailable, never simulated.
- Stale prices are flagged, never refused: `PRICE_CHANGED`, `SNAPSHOT_EXPIRED` (after `OFFLINE_WINDOW_HOURS`), `CLOCK_ADJUSTED`.
- A different total than the snapshot gives, a closed or foreign shift, a cashier no longer active, or any checkout refusal → quarantined; a manager retries or dismisses; the shift cannot close until then.
- Invoice numbering offline is **an open compliance question** (see `docs/compliance`): offline receipts carry a local reference and say they are not invoices; the register number is assigned at sync.

## 9. Integrations

Every external system sits behind a port interface with: auth, request validation, retries with backoff, idempotency key, timeout, structured error mapping, metrics, and a reconciliation path. Inbound webhooks: signature verification + replay window + idempotent processing keyed by provider event id.

## 10. Observability

Structured JSON logs (pino) with `correlation_id`, `tenant_id`, `user_id` (no PII, no secrets, no payment data). OpenTelemetry traces/metrics once the API has real workflows (Phase 1). Business metrics listed in the spec §16 are emitted from the modules that own them.

## 11. Known gaps / open decisions

- BIR invoicing route (CAS/CRM-POS registration, EIS, offline numbering) — research in `docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md`; production invoice issuance is **disabled** until reviewed. Key constraints from that research: BIR advisory (14 Sep 2026) says no e-invoicing provider is accredited — Tilvara must never claim accreditation; RMO 24-2023 requires re-accreditation for "major enhancements", so invoicing (numbering, grand total, e-journal, X/Z readings, invoice rendering) must be a **separately versioned, change-controlled `invoicing` module** with its own release cadence, isolated from fast-moving features.
- Competitor positioning: `docs/research/COMPETITOR_ANALYSIS.md` (StoreHub is the main PH rival; Square/Toast unavailable in PH).
- Payment provider: **PayMongo** (decided 2026-10-15); Phase 2 ships `DevPaymentProvider` only until sandbox keys exist. Card/QR refunds wait for that adapter (cash refunds only today).
- Hosting target (AWS ap-southeast-1 vs GCP asia-southeast1 vs local DC for data residency) — undecided; docker images keep this open.
