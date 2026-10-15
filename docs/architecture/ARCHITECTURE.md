# 1POS — Architecture

Status: Phase 0 baseline (2026-10-15). Living document — update it when the implementation diverges.

## 1. Assessment of the starting point

- Repository: **empty** at start (greenfield, initialised 2026-10-15 at `~/projects/1pos`).
- Tooling available on the dev machine: Node 24.12, pnpm 10.33, Docker 29, psql 16 client, git 2.51.
- **Not available:** Rust/cargo — required for the Tauri desktop shell (Phase 5). The POS UI is built as a React app first; Tauri packaging is a later step (see ADR-0006).
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
               │  restaurant · cash · accounting · customers · reports  │
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
  pos-desktop/    React POS; Tauri shell + SQLite later                                [Phase 2/5]
  mobile/         Expo, only when justified                                            [Phase 6+]
packages/
  money/          exact decimal Money/Quantity, allocation, rounding  (pure, no deps but decimal.js)
  config/         env schema + validation (pure)
  database/       Drizzle schema, migrations, tenant-scoped transaction helper
  tax/            versioned tax rules, PH VAT / SC-PWD computations (pure)             [Phase 2]
  pricing/        price resolution, discounts, promotions (pure)                       [Phase 2]
  inventory/      ledger rules, costing (pure)                                         [Phase 2/3]
  accounting/     posting rules, balance validation (pure)                              [Phase 3]
  sync-protocol/  offline envelope schemas shared by POS and API                         [Phase 5]
  validation/     zod request/response contracts shared with clients                     [Phase 1]
  ui/             shared React components (shadcn-based)                                 [Phase 1]
  hardware-adapters/ printer/drawer/scanner/scale interfaces + dev impls                [Phase 5]
```

Packages are created **when first needed**, not as empty shells.

Dependency rules (enforced by review now, by lint rule later):
1. Pure calculation packages (`money`, `tax`, `pricing`, `inventory`, `accounting`) never import `database`, Nest, or I/O.
2. `apps/*` may depend on `packages/*`; packages never depend on apps.
3. Inside `apps/api`, a module may call another module only through that module's exported service. Cross-module table access is forbidden.
4. Clients (`admin-web`, `pos-desktop`) depend only on `validation`, `money`, `ui`, `sync-protocol` — never on `database`.

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

## 6. Transaction engine (checkout) — design

Checkout is an explicit state machine persisted in `checkout_intents`:

```
RECEIVED → PRICED → (STOCK_CHECKED) → AWAITING_PAYMENT ─┬─► PAYMENT_CONFIRMED → COMMITTED
                                                        ├─► PAYMENT_PENDING_RECONCILIATION
                                                        └─► FAILED / CANCELLED
```

1. Request carries `Idempotency-Key` + `terminal_txn_id` (UUIDv7 generated on the terminal).
2. Guard resolves user → membership → branch/register → open cashier session (server-side, never from body).
3. Pricing/tax recomputed from DB configuration versions; client totals are only compared, never trusted. A mismatch returns `409 PRICE_CHANGED` with the authoritative quote.
4. **Short DB tx #1**: persist intent + quote snapshot + idempotency record.
5. Electronic payment: call provider **outside** any DB transaction, keyed by the intent id (provider-side idempotency). Cash: no external call.
6. **Short DB tx #2**: sale, sale lines (with name/SKU/price/tax snapshots), tenders, stock movements, balance updates (row locks in a deterministic order: sorted by `inventory_item_id`), journal entry (validated balanced), invoice number allocation, outbox events, idempotency result.
7. Post-commit: worker relays outbox (receipt print job, EIS transmission, notifications).
8. Unknown payment outcome (timeout) → intent stays `PAYMENT_PENDING_RECONCILIATION`; a reconciliation job queries the provider by intent id. Never re-charge blindly.

Refunds, voids, exchanges are **new documents** linked to the original; nothing posted is updated in place.

## 7. Inventory

Authoritative history = `stock_movements` (append-only, enforced by trigger). `stock_balances` is a transactional projection updated in the same DB transaction as the movement and verifiable by a reconciliation query (`sum(movements) = balance`). Weighted-average cost stored on the balance row. Negative-stock policy is per tenant/branch/item: `BLOCK`, `ALLOW_WITH_FLAG`, `ALLOW`. Offline sales may drive stock negative when policy allows; every such case is flagged for review.

## 8. Offline-first POS (Phase 5 design target)

- Terminal holds SQLite: catalog snapshot (versioned), price/tax config versions, local outbox of completed sales, device sequence counter.
- A sale is written to SQLite (single local transaction) **before** sync is attempted.
- Sync endpoint is idempotent on `(tenant, terminal_id, terminal_txn_id)`; server re-validates everything and returns the original result for duplicates.
- Offline: cash only. Card/e-wallet unavailable (not simulated). Stale-price policy: sale is accepted at the price version the terminal used if that version was valid within the configured offline window; otherwise flagged.
- Invoice numbering offline is **an open compliance question** (see `docs/compliance`): the planned approach is per-register pre-allocated serial blocks, pending BIR rule verification.

## 9. Integrations

Every external system sits behind a port interface with: auth, request validation, retries with backoff, idempotency key, timeout, structured error mapping, metrics, and a reconciliation path. Inbound webhooks: signature verification + replay window + idempotent processing keyed by provider event id.

## 10. Observability

Structured JSON logs (pino) with `correlation_id`, `tenant_id`, `user_id` (no PII, no secrets, no payment data). OpenTelemetry traces/metrics once the API has real workflows (Phase 1). Business metrics listed in the spec §16 are emitted from the modules that own them.

## 11. Known gaps / open decisions

- BIR invoicing route (CAS/CRM-POS registration, EIS, offline numbering) — research in `docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md`; production invoice issuance is **disabled** until reviewed. Key constraints from that research: BIR advisory (14 Sep 2026) says no e-invoicing provider is accredited — 1POS must never claim accreditation; RMO 24-2023 requires re-accreditation for "major enhancements", so invoicing (numbering, grand total, e-journal, X/Z readings, invoice rendering) must be a **separately versioned, change-controlled `invoicing` module** with its own release cadence, isolated from fast-moving features.
- Competitor positioning: `docs/research/COMPETITOR_ANALYSIS.md` (StoreHub is the main PH rival; Square/Toast unavailable in PH).
- Payment provider selection for PH (e.g. PayMongo, Maya, GCash via aggregator) — undecided; Phase 2 ships `DevPaymentProvider` only.
- Hosting target (AWS ap-southeast-1 vs GCP asia-southeast1 vs local DC for data residency) — undecided; docker images keep this open.
