# ADR-0021: Retail stores and boutiques — promotions, sizes and colours, quick keys, labels, shelf locations

- Status: Accepted (2026-10-20, session 26). The user asked for a review of the "Retail Stores & Boutiques" industry (`docs/INDUSTRIES.md`). Barcode scanning and quick checkout were strong; multi-item pricing was missing; stock was per branch only. They chose (the recommended option each time) SC/PWD winning over promotions, promotions offline via the snapshot, a shelf field plus an all-branch stock view (not bin-level stock), and printable label sheets from the admin.
- SPEC §6.2 (variants, multiple barcodes, bundles), §6.3 (barcode scanning, discounts and promotions), §6.6 (stock). Builds on ADR-0008 (tax engine), ADR-0009 (checkout), ADR-0015 (offline), ADR-0017 (line discounts).

## Decision

### 1. Promotions are rules applied by one pure function, on both sides
- A new package, `@1pos/pricing` (no I/O, no clock), holds `applyPromotions(lines, promotions, rounding)`. The server (`TaxService.computeCart`) and the offline till (`@1pos/pos-offline`) call the same function, so an offline total matches the server's re-pricing.
- **Three kinds**, each over a set of items (variants; mix and match within the set):
  - `MULTI_BUY`: `quantity` items for `price` ("3 for ₱100"). The price is on the price list's basis (VAT-inclusive when the list is).
  - `BUY_X_GET_Y`: buy `buyQuantity`, get `getQuantity` at `getRate` off (`1` = free). The cheaper units are the ones discounted.
  - `QUANTITY_BREAK`: tiers of `minQuantity` → `rate` off. The highest tier reached by the total quantity of the set applies to every line of the set.
- **Which lines take part**: lines of counter sales (quote, checkout, held carts resumed, the new sale of an exchange) and offline sales. A line is left out when it has:
  - a manual discount (a cashier's discount replaces any promotion);
  - an approved price;
  - SC/PWD (the statutory discount wins, never stacked; tax adviser to confirm, LEFTOVER);
  - or, for `MULTI_BUY`/`BUY_X_GET_Y`, a quantity that is not whole (only whole units are counted).
  
  Restaurant checks were not promoted: a bill kept its own order discount (ADR-0014, withdrawn 2026-10-25).
- **One promotion per line, the customer's best**: each promotion is evaluated on the lines not yet claimed. The one giving the largest discount is applied (ties go to the earlier start, then the id), and every line that took part in it is claimed (including a multi-buy's units that paid full price). This repeats until nothing more applies.
- **Units**: lines are expanded into units sorted by unit price (highest first, then line order). `MULTI_BUY` takes groups of `quantity` from the top, and each group's discount is `max(0, Σ prices − price)`. `BUY_X_GET_Y` takes groups of `buy + get`, and the last `get` units of each group are discounted. A group's discount is split over its lines in proportion to their amounts, rounded to centavos with the largest remainder, so the parts add up exactly.
- **What it produces**: per line, a `discount` amount and the `promotionId`. The discount enters the tax engine exactly as an ordinary line discount, so VAT, sales buckets, the ledger (revenue is net of ordinary discounts), returns (pro rata of the line) and reports need no new rule. `sale_lines.promotion_id` records which promotion priced the line. No permission is needed at the till (a promotion is not cashier discretion).
- **Definition and history**: `promotions` (name, kind, parameters, `starts_at`, `ends_at`, all branches or the listed ones) and `promotion_items` (the set). The terms are never edited once created: only the name can change, and the promotion can be ended (`ends_at` moved to now). Changing the terms means ending it and making a new one. So a sale can always be re-priced as of any instant (an offline sale as of its snapshot). They are managed with `prices.manage`. The catalog version is bumped on any change, and the next start or end counts as the till's next scheduled change (`nextChangeAt`).
- **Offline**: the snapshot carries the promotions in force at its `asOf` for its branch. `recordOffline` re-prices as of the snapshot, as before. `PRICE_CHANGED` is also flagged when the promotions in force at completion differ from the snapshot's.
- **Shown**: the promotion's name under its line on the till, the receipt and the sale page. The report "Promotions" gives discount given, sales and units per promotion over a period.

### 2. Sizes and colours
- The admin generates a product's variants from up to three options (e.g. Size: S, M, L × Colour: Red, Blue), at most 100. Each variant is saved with its `attributes` (`{"Size": "M", "Colour": "Red"}`), a name ("M / Red") and an SKU built from the base and the option values. On an existing product, the same grid adds the missing combinations. One price (and optional cost) for all of them, which can be changed per variant afterwards.
- The report "Sales by size and colour" (`GET /v1/reports/by-attribute?attribute=…`) totals sales lines by the value of one attribute of the variant sold.

### 3. Quick checkout
- **Quantity before a scan**: `5*` then the code (or `5×`) sells 5. Decimals are allowed for items sold by weight or in fractions. A plain `x` is not read as times, because SKUs such as `2X4-PINE` contain one.
- **Quick keys**: `product_variants.quick_key_position` (1–48, `catalog.manage`). The Sell screen shows those items as buttons, online from `GET /v1/catalog/quick-keys?branchId` and offline from the snapshot.
- **Discount on the whole cart**: a till action that puts the same rate on every line that has no promotion, approved price, SC/PWD or discount of its own. These are ordinary line discounts (ADR-0017): the same permission, online only.

### 4. Barcodes and labels
- `POST /v1/products/variants/:id/barcodes/generate` gives a variant an in-store EAN-13 (`29` + 10 random digits + check digit, retried on a clash). An exact barcode match is looked up before scale labels, so these never read as weights.
- Admin Products → Labels prints items × copies on a chosen layout: A4 sheets of 21 or 40, a 50 × 30 mm roll, or a shelf-edge strip. Each label shows the name, the price at a chosen branch, the barcode (EAN-13 when the code is a valid EAN-13, else Code 128) and the shelf location. Barcodes are drawn as SVG by our own encoder, and the page goes through the browser's print dialog.

### 5. Shelf locations and stock across branches
- `item_locations` (branch, variant, `location` up to 32 characters, e.g. "A3-2"): where the item sits in that branch. It is a label, not stock; quantities stay per branch. It is set with `inventory.adjust` or `inventory.count` at the branch and audited. It is shown and sortable on the stock list, count sheets and labels.
- `GET /v1/stock/balances/by-branch` shows the stock of every branch the reader can read inventory at, item by item. The admin stock page has "All branches".

## Consequences
- New tables `promotions`, `promotion_items` and `item_locations`. New columns `sale_lines.promotion_id` and `product_variants.quick_key_position`. A new package, `@1pos/pricing`.
- New snapshot fields: `promotions`, and each item's `quickKey`. An older till ignores them, but then it rings promoted items at full price and the server refuses the total (`TOTAL_MISMATCH` → quarantined, not lost), so tills update with the server.

## Not covered (LEFTOVER)
- Promotions by category, cart-level offers ("₱100 off ₱1,000"), coupons and loyalty.
- A promotion that cheapens a different item set ("buy a shirt, socks half price").
- Choosing per sale between a promotion and SC/PWD: the statutory discount always wins, and the tax adviser should confirm (RA 9994 IRR: no double discount).
- Bin-level stock (quantities per shelf), label printers driven by the till, and serial numbers.
