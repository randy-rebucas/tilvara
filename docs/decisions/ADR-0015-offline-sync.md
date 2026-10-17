# ADR-0015: Offline cash sales and synchronization

- Status: Accepted (2026-10-17). Defaults chosen by the engineer; the user may revisit the starred (★) policies.
- Builds on: ADR-0006 (POS client), ADR-0008 (tax engine), ADR-0009 (checkout), ADR-0010 (payments), ADR-0013 (ledger).

## Context
SPEC §11 and Phase 5 require a POS that keeps selling during supported outages: a durable local store, a
durable queue written before any network call, unique terminal transaction ids, monotonic device
sequence numbers, idempotent sync that returns the original result, retry with backoff, visible conflicts
and recovery after a restart. Only cash works offline; card and e-wallet are never simulated.

Constraints on this machine (at the time): no Rust toolchain yet, so the Tauri shell could not be built (installed in session 8). Everything below
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
- **Slice 3**: `@1pos/escpos` (layout + ESC/POS bytes, pure). In the POS: converters for online and
  offline receipts, and `escposPrinter` / `escposDrawer` on a byte channel. A print failure never touches
  the sale; the cashier prints again.
- **Slice 4 (admin)**: `/offline-sales` review screen. The POS outage banner, sync status and offline
  selling wait for the shell (slice 5).
- **Known gaps**
  - The queue of a **revoked** terminal can only be recovered by an administrator; no tool exists yet.
    Its envelopes name that terminal's snapshot, so another terminal cannot deliver them.
  - Device sequence numbers restart if the SQLite file is lost or restored from an old backup. The
    server dedupes by transaction id, not by sequence.
  - ~~`SNAPSHOT_EXPIRED` has no integration test~~ — added (session 8): snapshots aged 23 h / 25 h.

## As built (slices 4–5, desktop till, 2026-10-17)
- **Shell** (`apps/pos-desktop/src-tauri`, Tauri 2): the React POS in WebView2, with three native modules
  behind ten commands. Each command needs an explicit grant in `capabilities/default.json`, and there
  are no shell, file-system or HTTP plugins.
  - `store`: the till database. **Deviation from §8**: not the Tauri SQL plugin, but one `rusqlite`
    connection behind a mutex. The plugin runs on a connection pool, so a `BEGIN … COMMIT` spread over
    several IPC calls could land on different connections. One connection makes `transaction()` mean
    what `SqlDriver` promises. WAL + `synchronous=FULL`, bundled SQLite. A new page first rolls back
    any transaction a previous page left open (reload or web view crash mid-transaction). That work
    never committed.
  - `printer`: raw ESC/POS to a network printer (TCP, usually 9100) or a printer installed in Windows
    (spooler, RAW datatype), with a deadline; Windows printers are listed for the picker.
  - `secrets`: the terminal credential in Windows Credential Manager, keys allow-listed (`terminal`).
  - `ONEPOS_TILL_PROFILE` gives a separate database and credential entry (E2E runs never touch a real
    till).
  - CSP: scripts from the app only; `connect-src` the API (https, and loopback for development).
    `freezePrototype` is off: a bundled library assigns `toString` on its own objects, which throws
    under a frozen `Object.prototype`.
- **POS** (`lib/till.tsx`, `components/Till.tsx`)
  - Set-up on first launch (terminal id + one-time key, checked against the API before they are kept),
    or "continue online only".
  - Band chip: online / offline · N to send · N need review, opening the till settings (status, send
    now, printer, disconnect); an outage banner.
  - Offline selling in `Sell`:
    - the scan falls back to the snapshot (barcode or SKU) on the first unanswered lookup;
    - pricing comes from `engine.quote`, the same tax engine the server re-runs;
    - cash only, with no SC/PWD or card/QR offered;
    - only on the shift the snapshot knows (same register, same open session); the counter refreshes
      the snapshot when it opens on a shift.
  - **Lost answer, then offline**: the offline envelope reuses the checkout's `clientTransactionId` as
    its `terminalTxnId`. If the online attempt had reached the server, the delivery is refused as
    `DUPLICATE_TRANSACTION` and quarantined, so it is never counted twice. A manager dismisses it.
    Locally, `ringUp` is idempotent on that id.
  - Receipts print to the configured thermal printer (`Receipt` and `OfflineReceipt`). The snapshot
    carries `legalEntity.receiptTin`, so offline receipts print the TIN as online ones do.
  - Server address: entered at set-up and checked by fetching a snapshot, then kept in the till
    database (`api_url`) and used from launch on. `VITE_API_URL` only pre-fills the field. Only
    `https://` is accepted, or plain `http://` to this computer (development), so the terminal key never
    crosses a network unencrypted. The API allows `http://tauri.localhost` in its default
    `CORS_ORIGINS`.
- **Tests**:
  - Rust 8: store, printer, secrets;
  - engine 9 (+ checkout id, lookup);
  - `test:e2e:desktop` 20 checks: the real exe under CDP behind a proxy the script cuts. It covers
    set-up, a lost answer then offline (counted once, the copy quarantined as a duplicate), an offline
    sale, a restart during the outage with the queue intact, and reconnecting (both sent, drawer
    ₱1,077.80).
## Exit review (slice 7, 2026-10-17)
SPEC Phase 5 exit criterion: *supported offline workflows recover correctly after restarts, retries and
network failures*. **Met for offline cash sales.** Two Phase 5 items are deferred by the user's decision
(2026-10-17, "continue without PayMongo"):
- payment integration hardening (PayMongo adapter, webhooks, card/QR refunds) waits for sandbox keys;
- invoice transmission waits for the compliance gate.

**SPEC §11 trace**

| Requirement | Where | Tested by |
|---|---|---|
| SQLite local store; local catalog cache | `src-tauri` store; snapshot | cargo store tests; desktop E2E |
| Versioned price and tax configuration | snapshot `as_of`; re-pricing as of it | offline-sync (flags, expiry) |
| Local cashier session | shift opened online, sold offline by its opener ★ | engine unit; desktop E2E |
| Durable queue, written before any network call | `ringUp` → outbox in one local transaction | engine unit; drills |
| Unique terminal transaction ids; monotonic device numbers | envelope | engine unit; restore drill |
| Idempotent sync returning the original result | `terminal_transactions` + payload hash | offline-sync; lost-answer drills |
| Retry with backoff | engine (1 s → 5 min, jitter) | engine unit; drills |
| Conflict handling | flags; quarantine + retry/dismiss; duplicate of an online sale | offline-sync; desktop E2E; admin E2E |
| Sync status visibility | till chip + settings; admin review screen | desktop + admin E2E |
| Recovery after restart | queue in the file; resume on launch | restart drill; desktop E2E restart |
| **Monitoring for delayed or failed sync** | **added in the exit review**: `GET /v1/sync/terminals` and the admin "Tills" panel (silent = open shift and over 30 min without contact); flags shown on recorded sales | offline-sync "till health"; admin E2E |
| Do not simulate card/e-wallet offline | cash only offline | desktop E2E |
| Stale-price policy; offline numbering; stock below cloud | §5–§7 ★ | offline-sync; ADR text |

**Drills added**
1. Two tills on one register sell offline on the same shift and sync at the same moment. 8 sales, numbers
   1–8 with no gaps, drawer ₱1,268.80, stock 488, audit clean.
2. Closing the shift races the till's sync, 4 rounds per run. Each round either records the sale and
   counts it in the close, or closes and quarantines the sale as `SESSION_NOT_OPEN` (expected cash
   without it). Both orders were observed across runs, and no sale lands on a closed shift.
3. A till restored from an old backup. Old envelopes replay ("already recorded"); a new sale reuses a
   device number under a new transaction id and is recorded; 3 sales, drawer ₱1,089.60, audit clean.

**Defects found and fixed in the review**
- The till fetched a full snapshot every 30 s even online: about 2,900 snapshot rows per till per day,
  each carrying the whole catalogue. Now every 10 min online, and every 30 s only while offline.
- Flags (`PRICE_CHANGED`, `SNAPSHOT_EXPIRED`, `CLOCK_ADJUSTED`) were stored but shown nowhere. The
  recorded tab now shows them in words.
- For a sale whose till clock was off, the admin showed the till's (wrong) time as "Rung up". It now
  shows the recorded time; the flag shows what the till said.

**Not drilled**: a sale falling in a closed accounting month (`PERIOD_CLOSED`). It needs a shift and
prices dated a month back. It relies on the ledger's closed-period guard (ledger tests) and the generic
quarantine, retry and dismiss path (offline-sync).

**Runbook**: `docs/operations/offline-terminal-recovery.md` (SPEC §16 "offline terminal recovery").

- **Known gaps (desktop)**
  - After a restart during an outage nobody can sign in (sign-in needs the API), so selling waits for
    the connection; an offline PIN for the shift's cashier is the candidate.
  - No serial/COM-port printers except through a Windows driver; no printer status (DLE EOT).
  - No signed installer or auto-update yet (only `--debug --no-bundle` builds have been made); not yet
    run against real printer or drawer hardware. Changing a till's server means disconnecting and
    setting it up again.
