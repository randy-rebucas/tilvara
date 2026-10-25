# ADR-0020: Sari-sari stores and groceries — packs and pieces (tingi), expiry dates

- Status: Accepted (2026-10-20, session 24); **§1 withdrawn (2026-10-25)**: the GROCERY business type was removed (retail only, migration 0112 made every business RETAIL). Packs and pieces, expiry lots, alerts and write-offs (§2–§4) stay for every shop. Originally: The user chose a fourth business type, automatic pack opening at the sale, and expiry lots drawn first-expiry-first without picking (the recommended option of each question).
- SPEC §6.2 (batch and expiry tracking, units of measure), §6.6 (damaged and expired stock, units and conversions, low-stock alerts). `docs/INDUSTRIES.md`. Builds on ADR-0009 (checkout), ADR-0012 (costing), ADR-0013 (ledger), session 17 (business types).

## Decision

### 1. A fourth business type, GROCERY ("Sari-sari store or grocery")
*Withdrawn 2026-10-25 (migration 0112): former GROCERY businesses are RETAIL.*
- `tenants.business_type` takes `GROCERY`. It gates like RETAIL: no tables, menus or kitchen (the server refuses restaurant writes with `BUSINESS_TYPE_EXCLUDES_FEATURE`), no restaurant roles, selling by weight on. One rule replaces the RETAIL checks everywhere: a business **serves tables** when its type is RESTAURANT or HYBRID.
- Packs and expiry dates (below) work for every type. For GROCERY a new product starts with “Keeps expiry dates” ticked, its trial gets sari-sari sample items (untracked like every sample set, so trying them never touches stock), and the guide has the part "Tingi and expiry dates".

### 2. Packs and pieces (tingi)
- **A pack and its piece are two items**, each with its own stock, price and barcode, linked by `pack_conversions` (pack variant, piece variant, `pieces_per_pack` > 1, decimal so a 25 kg sack can feed a by-the-kilo item, `auto_open`). A piece has at most one active pack. A link cannot form a loop. Both items must track stock. A link is never edited in place: changing the count archives it and makes a new one, so old openings keep the count they used.
- **Opening a pack is a document**, `pack_openings` (branch, conversion, whole packs, pieces, optional `sale_id`, reason). It moves stock as two new movement types: `UNPACK_OUT` (the packs, outbound at their average cost) and `UNPACK_IN` (the pieces). The costing trigger prices the pieces like a transfer receipt: the pack's out-value divided by the pieces. The opening posts one entry: inventory in − inventory out, with any revaluation of pieces sold short (and rounding) to COGS, as for receipts and transfers. Usually it nets to zero and posts nothing.
- **Manual**: `POST /v1/stock/pack-openings` (`inventory.adjust`, Idempotency-Key), admin Inventory → Packs.
- **Automatic at the sale**: in `SalesService.record()` (counter sales, checks and offline sales alike), when the sale and its recipe consumption need more of a piece than is available (on hand − reserved), and the piece has an `auto_open` pack with whole packs available, the sale opens just enough packs (`ceil(short / pieces_per_pack)`, at most the packs available) in the same transaction, before the sale's own movements and before the BLOCK check. Every balance involved (the sold items and their packs) is locked first, in variant order, in one call. Whatever is still short follows the branch's negative-stock policy as before.
- One level only: a sale opens a pack, never a case to get a pack (LEFTOVER). A returned piece comes back as a piece; the pack stays opened.

### 3. Expiry dates (lots drawn first-expiry-first)
- `products.tracks_expiry`. A dated quantity is a **lot**: `stock_lots` (branch, item, `expires_on`, optional `lot_code`, quantity left). Each draw or return is a row in the append-only `stock_lot_movements`. Both are written only by the definer trigger `app_track_stock_lots` (AFTER INSERT on `stock_movements`), never by the app, so every path (sales, offline sales, consumption, transfers, waste, counts, supplier returns, openings) keeps the lots without knowing about them.
- **Where dates come in**:
  - a goods receipt line carries `expires_on`/`lot_code` (required for an item that tracks expiry), and so does an inbound stock adjustment;
  - a transfer receipt brings the dates that left the source;
  - pieces from an opened pack take the pack's dates;
  - a customer return goes back to the lots its sale drew from.
  - Anything else coming in (a count surplus, an undated adjustment) is **undated**.
- **The rule**: the dated lots never hold more than is on hand (`Σ lots ≤ max(on hand, 0)`); the rest is undated stock. Going out, undated stock goes first, as the oldest (it came in before dates were kept, or without one); then lots in order of expiry. A movement that names a lot (`lot_id`, a write-off of that lot) takes it from that lot first.
- **Expiring soon**: `GET /v1/stock/expiring?branchId&withinDays` lists expired and soon-to-expire lots with their value at average cost. Admin Inventory → Expiry has "Write off" per lot: a WASTE adjustment naming the lot, reason "Expired".
- **Alerts**: `inventory_settings.expiry_alert_days` (default 30; 0 turns them off). The worker's hourly pass calls `platform_flag_expiring_lots()`. It marks each lot once when it enters the window (branch calendar), and writes one `stock.expiring` outbox event per branch; the worker mails the branch's stock keepers, like `stock.low`.
- Cost stays weighted-average per item (ADR-0012). Lots carry quantities only.

### 4. Low-stock alerts
Already built (session 16): reorder points, the `stock.low` mail and the admin's low-stock list. The grocery guide part explains them.

## Consequences
- New tables: `pack_conversions`, `pack_openings`, `stock_lots`, `stock_lot_movements`. New columns: `products.tracks_expiry`; `stock_movements.pack_opening_id`, `expires_on`, `lot_code`, `lot_id`; `goods_receipt_lines.expires_on`, `lot_code`; `inventory_settings.expiry_alert_days`. Movement types `UNPACK_OUT`, `UNPACK_IN`. Journal source `PACK_OPENING`.
- The traceability audit, `ledger.test.ts`, the isolation suite, `rls-catalog`, the data export and the admin movement labels learn the new types and tables.

## Not covered
- Opening a case to get a pack at the sale (chains of packs). Manual openings work at any level.
- Choosing the lot at the till, or keeping cost per lot.
- Dates on count sheets and on supplier returns (a count surplus is undated; a supplier return draws by the rule).
- Warning the cashier about expired stock at the till.
