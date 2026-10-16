# ADR-0015: Offline cash sales and synchronization

- Status: Accepted (2026-10-17). Defaults chosen by the engineer; the user may revisit the starred (★) policies.
- Builds on: ADR-0006 (POS client), ADR-0008 (tax engine), ADR-0009 (checkout), ADR-0010 (payments), ADR-0013 (ledger).

## Context
SPEC §11 and Phase 5 require a POS that keeps selling during supported outages: a durable local store, a
durable queue written before any network call, unique terminal transaction ids, monotonic device
sequence numbers, idempotent sync that returns the original result, retry with backoff, visible conflicts
and recovery after a restart. Only cash works offline; card and e-wallet are never simulated.

Constraints on this machine: no Rust toolchain yet, so the Tauri shell cannot be built. Everything below
the shell — the protocol, the server side, and the client engine with its SQLite store — is TypeScript and
can be built and tested now. The shell later only supplies the SQLite driver and device adapters.

## Decision

### 1. What works offline (MVP)
- **Cash retail sales** on a shift that was **opened online** on the terminal's register, by the user who
  opened it. Opening and closing a shift, returns, voids, card/QR, discounts (ordinary and SC/PWD) and
  restaurant orders need the server. ★
- The POS shows the outage, disables what is not allowed, and shows how many sales wait to sync.

### 2. Terminal identity
- The desktop app holds the **terminal credential** issued in the admin (Phase 1: one-time secret, only its
  hash stored, revocation final). Sync and snapshot calls authenticate as the terminal
  (`X-Terminal-Id` + `Authorization: Terminal <secret>`), checked by a SECURITY DEFINER function owned by
  `onepos_platform` (the app role still cannot read hashes). A revoked terminal is refused (401); its
  queue stays on the device.
- A terminal is bound to one register; it may sync only sales of shifts on that register.

### 3. Snapshot (local catalog cache, versioned config)
`GET /v1/terminal/snapshot` returns, for the terminal's register: branch, legal entity, the tax profile in
force, every active priced item with its branch price (price id, amount, tax inclusion), its tax
treatment, unit rules and stock tracking, and the open shift on the register. Each snapshot is recorded
(`terminal_snapshots`: id, terminal, `as_of` from the DB clock). The client prices offline sales with the
same pure engine (`@1pos/tax`) from that snapshot.

### 4. Offline sale envelope (`@1pos/sync-protocol`)
`{ terminalTxnId (uuid), deviceSeq (int, strictly increasing per terminal), snapshotId, cashierSessionId,
cashierUserId, occurredAt (device clock), localReference, lines [{ variantId, quantity }],
tenders [{ method: 'CASH', tendered }], amountDue }`. The envelope is written to the local queue in the same
local transaction as the sale and the sequence counter, **before** any network call.

### 5. Sync (`POST /v1/sync/sales`, terminal auth)
- A batch of envelopes, processed in `deviceSeq` order, **one database transaction per envelope**, so
  one bad sale never blocks or rolls back the others.
- Idempotent on `(terminal_id, terminal_txn_id)` in `terminal_transactions` (with a payload hash): a
  retried envelope gets its original result; the same id with a different payload is refused
  (`TXN_ID_REUSED`).
- Each result is `RECORDED` (sale id and number), or `QUARANTINED` (code, details).
- The server **re-validates everything** and re-prices **as of the snapshot's `as_of`** (prices and tax
  profiles are append-only and effective-dated, so this reproduces what the terminal saw exactly). Then
  it records through the one checkout path (`SalesService.record`: number, lines, tender, drawer, stock,
  consumption, books, audit, outbox).
- **Stale-price policy ★**: the sale stands at the snapshot's prices.
  - It is flagged `PRICE_CHANGED` when a different price or tax profile was in force at `occurredAt`.
  - It is flagged `SNAPSHOT_EXPIRED` when `occurredAt` is later than `as_of` + `OFFLINE_WINDOW_HOURS`
    (default 24).
  - The cash is already in the drawer, so a flag never refuses the sale.
- **Clock**: the sale's `completed_at` is the device time, clamped to [shift opened, now]. It is flagged
  `CLOCK_ADJUSTED` when the clamp moved it by more than 5 minutes (ordinary drift is not flagged).
  Reports and the books date offline sales by when they happened.
- **Snapshot time** is the plain DB clock, not "in force now" with its 5 s skew allowance (ADR-0009 §8).
  Otherwise a price set seconds after the snapshot would count as in force when the sale is re-priced.
- **Quarantine** (recorded nothing, needs a manager):
  - the total the terminal charged differs from the server's re-pricing (`TOTAL_MISMATCH`);
  - the shift is not open, belongs to another register, or the cashier is not the shift's owner;
  - any refusal from the checkout path (item archived, no permission, period closed, subscription
    read-only, …).

  Quarantined sales are listed for managers. A manager can **retry** one, once the cause is fixed, or
  **dismiss** it with a reason; any cash taken then shows up as a drawer variance.
- A shift cannot close while it has quarantined offline sales (`OFFLINE_SALES_UNRESOLVED`). The client
  syncs before closing.

### 6. Numbering ★
Offline receipts print a local reference (`<register>-T<terminal hint>-<deviceSeq>`) and say they are
offline receipts. The register's gapless sale number is assigned when the sale syncs. Every receipt says
"THIS IS NOT AN OFFICIAL INVOICE" while invoicing is disabled. Offline invoice numbering stays an open
compliance question (pre-allocated serial blocks are the candidate; `docs/compliance`).

### 7. Stock while offline ★
Offline sales may take stock below what the cloud knows (as online sales may today); the movement and
any negative balance stay visible, and offline sales are marked (`sales.origin = 'OFFLINE'`). A
configurable BLOCK policy cannot be enforced without connectivity and is not offered offline.

### 8. Client engine (`packages/pos-offline`)
- No React: a `LocalStore` over a minimal SQL driver. `node:sqlite` serves tests; the Tauri SQL plugin
  serves the desktop app.
- Tables: snapshot, queue (envelope, status, attempts, next try, result), device sequence.
- `ringUp` prices, writes the sale and its envelope atomically, and returns the local receipt.
- `sync` sends what is pending in sequence order with exponential backoff and jitter.
  - Network errors and 5xx keep the envelope pending, and a retry reuses the same `terminalTxnId`.
  - 401 stops syncing and surfaces "terminal revoked".
  - Results are stored per envelope.
- On start, the engine resumes whatever is pending. A crash between the local write and the send loses
  nothing.

## Slices
1. **Server**:
   - terminal auth, snapshot, the sync endpoint, `terminal_transactions`, offline columns on `sales`;
   - quarantine list, retry and dismiss; the close guard;
   - `@1pos/sync-protocol`;
   - tests and isolation.
2. **Client engine** + SQLite store; drills against the real API (restart, lost answers, 503, duplicates,
   price change while offline, shift closed elsewhere, revoked terminal).
3. **ESC/POS** receipt encoder and the printer port (pure TS), offline receipt.
4. **UI**: POS outage banner and sync status; admin sync and quarantine screen; terminal set-up on the device.
5. **Tauri shell** (needs Rust): SQLite driver, printer and drawer adapters.
6. **Payments hardening and invoice transmission**: blocked on PayMongo sandbox keys and on the
   compliance gate.
7. **Exit review.**

## Consequences
- Two principals reach the API: users (bearer tokens) and terminals (sync and snapshot only).
- A sale's `completed_at` may be earlier than when it was recorded. Its journal entry is dated by when
  the sale happened, so a sale that falls in a month closed meanwhile is quarantined (`PERIOD_CLOSED`)
  until the month is reopened or the sale is dismissed.
- Browser mode stays online-only (ADR-0006); offline is claimed only for the desktop app once slice 5 ships.

## As built (slices 1–2, 2026-10-17)
- **Server**
  - Migrations 0041/0042: `terminal_snapshots` (append-only) and `terminal_transactions` (the only
    move is QUARANTINED → RECORDED or DISMISSED; never deleted), both with forced RLS.
  - `sales.origin` / `terminal_id` / `offline_reference` / `offline_flags`, with a check that ties them
    together.
  - `auth_terminal()` is SECURITY DEFINER, owned by `onepos_platform`.
  - Routes:
    - `GET /v1/terminal/snapshot` and `POST /v1/sync/sales`, with `@TerminalAuth()`; OpenAPI shows the
      `terminal` scheme;
    - `GET /v1/sync/transactions[/:id]` and `POST …/:id/retry|dismiss`, which need `cash.reconcile` at
      the register's branch.
  - `SalesService.recordOffline` re-prices through `computeCart(…, asOf)` and records through the
    shared `record()`, with the device time and the entry dated on the branch's local day. The delivery
    row commits with the sale.
  - Closing a shift is refused while it has quarantined offline sales.
- **Client**: `@1pos/sync-protocol` (envelope, snapshot and result types, `canonicalJson`) and
  `@1pos/pos-offline`:
  - `LocalStore` over `SqlDriver`; `node:sqlite` is the driver for now, and the Tauri SQL plugin comes
    in slice 5;
  - `OfflineEngine` with `ringUp`, `syncOnce` / `drain` (batches of 50), backoff of 1 s → 5 min with
    50–100 % jitter, `status`, and serialized work;
  - `httpTransport`.
- **Known gaps**
  - The queue of a **revoked** terminal can only be recovered by an administrator; no tool exists yet.
    Its envelopes name that terminal's snapshot, so another terminal cannot deliver them.
  - Device sequence numbers restart if the SQLite file is lost or restored from an old backup. The
    server dedupes by transaction id, not by sequence.
  - `SNAPSHOT_EXPIRED` has no integration test; it needs a snapshot older than the window with prices
    that existed then.
