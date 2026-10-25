# ADR-0025: Pharmacies and drugstores — drug data, generic lookup, prescriptions, batches, no expired sales, box/strip/piece

- Status: **Withdrawn (2026-10-25), except what every shop keeps.** The user removed PHARMACY and HYBRID ("Let's focus on retail for now"); migration 0112 drops pharmacy settings, pharmacist licences, prescriptions, their items and fills, dispensing approvals, the medicine details on products and the medicine label on sale lines (the data is deleted). Gone: drug classes and generic search (§2–§3), prescriptions and dispensing checks (§6), the SC/PWD purchase booklet requirement (§8), the Pharmacist and Pharmacy Assistant roles and `pharmacy.*` permissions (§9), the prescription book and dangerous drugs register (§10). **Kept for every (retail) shop:** the expired-stock rule (§4) — now null = **ALLOW** for every branch (0112 wrote BLOCK for every former PHARMACY/HYBRID branch that relied on the old default); lot codes (optional for every item now), lot holds and the batch trace (§5; under Inventory in the admin, API routes unchanged); the box → strip → piece pack chain opened at a sale (§7). Offline sales are still flagged `EXPIRED_STOCK`, never refused. Originally: Accepted (2026-10-21, session 30; built the same session — "As built" notes below each section where it differs from the plan). The user asked for the "Pharmacies & Drugstores" industry (`docs/INDUSTRIES.md`). They chose (the recommended option each time): **never sell expired stock** (counter sales refused, offline sales recorded and flagged), **prescriptions required by drug class** (Rx and antibiotics need a prescription record; dangerous drugs also need S2 and yellow-form numbers, a pharmacist, and are refused offline), and **pack chains** (a sale opens box → strip → piece). Built after the laundry session (ADR-0024, session 29) had finished its gate; migrations 0105–0106.
- SPEC §6.2 (batch and expiry, units), §6.3 (checkout), §6.6 (stock), §6.9 (customers), §12 (privacy). Builds on ADR-0008 (tax engine, SC/PWD), ADR-0009 (checkout, `record()`), ADR-0011 (returns), ADR-0012 (stock policy), ADR-0015 (offline), ADR-0017 (second-person approval), ADR-0018 (customers), ADR-0020 (packs and expiry lots), ADR-0022 (business type pattern).
- Legal points are assumptions to be checked by the pharmacist-in-charge and the tax adviser, recorded in `docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md` (§ Pharmacies). Nothing here claims FDA, DDB or BIR compliance.

## Review (before this ADR)
- There: expiry lots with an optional lot code, drawn first-expiry-first, alerts and write-offs (ADR-0020); SC/PWD 20 % + VAT exemption through `@1pos/tax`, with the beneficiary's name, ID number and TIN on the sale and the receipt and a signature line; the SC/PWD book report; VAT-exempt items (`vatTreatment`); packs and pieces one level deep; customers; second-person approval.
- Missing:
  1. expired lots are drawn **first** (they expire earliest) and nothing stops the sale;
  2. lot codes are optional, there is no recall trace and the receipt shows no batch;
  3. no drug class, prescription record or prescription book;
  4. no generic name, strength or dosage form; the till cannot search by generic name or offer equivalents (RA 6675);
  5. a sale cannot open a box to get a strip to get a tablet;
  6. SC/PWD medicine purchases do not record the purchase booklet or link the prescription.

## Decision

### 1. An eighth business type, PHARMACY ("Pharmacy or drugstore")
- `tenants.business_type` takes `PHARMACY`. It gates like RETAIL: `servesTables(PHARMACY)` is false. A new rule `servesPharmacy(type)` is true for PHARMACY and HYBRID: prescriptions, the pharmacy roles and reports, the "Never sell expired" default (§4). Other types get `BUSINESS_TYPE_EXCLUDES_FEATURE` on prescription writes; drug fields (§2) and lot tracing (§5) work for every type (an agrivet store sells animal medicines).
- For PHARMACY a new product starts with "Keeps expiry dates" ticked and a drug section open. Trial samples: a few OTC, Rx and antibiotic items with generic names, untracked like every sample set (so no box/strip chain: a pack link needs counted stock). The guide gets a part "Medicines, prescriptions and batches".
- Changing away from PHARMACY is allowed (prescriptions stay readable). *As built:* the expired-stock rule is not written when the type changes; a branch without its own setting follows the type (BLOCK for PHARMACY, §4).
- *As built:* a product may take a class other than OTC only in a PHARMACY or HYBRID business (403 `BUSINESS_TYPE_EXCLUDES_FEATURE`), so other types never meet a prescription line.

### 2. Drug data on products
- New nullable columns on `products`: `generic_name`, `strength` (free text, "500 mg", "250 mg/5 mL"), `dosage_form` (TABLET, CAPSULE, SYRUP, SUSPENSION, DROPS, CREAM, OINTMENT, INJECTION, INHALER, SACHET, OTHER), `drug_class` (OTC, RX, ANTIBIOTIC, DANGEROUS), `fda_registration_no`. A product is a **drug** when `drug_class` is set; CHECK: a drug is a STANDARD product with a generic name. *As built:* `tracks_expiry` is not forced by the database (trial samples are untracked); the admin form defaults it on for a pharmacy.
- The brand name is the product name. `generic_key` (generated: lower, trimmed, spaces collapsed generic name + strength + dosage form) drives equivalents; a trigram index on `generic_name` serves search.
- Changing a product's drug class is audited (old and new class); it applies to sales from then on, never to recorded ones.
- VAT: medicines that are VAT-exempt by law are set up as VAT-exempt items (existing `vatTreatment`); the guide explains it and SC/PWD on them is 20 % of the price (no VAT to remove), as the engine already does.

### 3. Generic and brand lookup
- Catalog search (`/v1/catalog/lookup`, the admin product list, the till) matches the generic name as well as name, SKU and barcode. Results and the terminal snapshot carry `genericName`, `strength`, `dosageForm`, `drugClass`, so the offline till searches and shows them alike.
- `GET /v1/catalog/equivalents?branchId&variantId` (`catalog.read`): other active items with the same `generic_key`, with branch price and sellable stock (§4), cheapest first. Offline the till finds them from the snapshot (price only).
- The till shows generic, strength and form under the brand, a class badge (Rx, Antibiotic, DD), and an "Equivalents" action on the line. The receipt prints the generic name and strength under a drug's line.

### 4. Never sell expired stock
*Kept (2026-10-25): for every shop; no setting now means ALLOW. Drug-only and recipe/restaurant/laundry mentions below are history.*
- `inventory_settings.expired_stock` per branch: `BLOCK`, `ALLOW` or null (*as built:* null = the business type's default, BLOCK for PHARMACY, ALLOW otherwise; `expiredStockRule(db, branchId)` and the lot trigger decide alike). Set with the other inventory settings (`org.manage`), audited.
- **Expired** = `expires_on` < today in the branch's calendar (sellable through its stated date), using the DB clock (`effectiveNowSql`). A lot can also be **held** (§5); held lots count as expired here.
- **Sellable** quantity = on hand − reserved − Σ expired-or-held lots.
- **Online sales** (counter sales, restaurant checks, laundry claims — everything through `record()` except offline): under BLOCK, a line that could only be filled from expired or held lots is refused with 409 `EXPIRED_STOCK` (item, sellable, expired or held, requested; *as built:* 409 like `INSUFFICIENT_STOCK`; a line merely short of stock is the negative-stock rule's), checked after automatic pack opening (§7) and before the negative-stock rule, under the same balance locks (`app_lock_stock_balances`). No override. Recipe consumption is flagged, never refused (as for negative stock).
- **The draw**: the lot trigger `app_track_stock_lots` orders lots for a SALE/CONSUMPTION/UNPACK_OUT movement at a BLOCK branch with unexpired, unheld lots first (then by expiry). Writes-off, supplier returns and transfers keep today's order (expired first). The invariant `Σ lots ≤ max(on hand, 0)` is unchanged.
- **Offline sales** are recorded (ADR-0015: never lost). *As built:* stock movements and sales are append-only, so the trigger marks the draw itself, `stock_lot_movements.expired = true`; the offline review derives the `EXPIRED_STOCK` flag from those draws, and `record()` emits `stock.expired_sold` (sale and branch ids) at a BLOCK branch, which the worker mails to the branch's stock keepers. A recipe's consumption that drew expired lots online is mailed the same way.
- The till shows "Expired stock" on a lookup hit whose sellable stock is short (online), and the refusal message names the lot to write off.

### 5. Batches: lot codes, recall trace, holds, receipt
*Kept (2026-10-25) except the drug-only parts: lot codes are optional for every item, the trace no longer names prescriptions.*
- A goods receipt line or inbound adjustment of a **drug** must carry `lot_code` as well as `expires_on` (422 `LOT_CODE_REQUIRED`). Other expiry items keep it optional.
- **Trace**: `GET /v1/stock/lots/trace?variantId&lotCode` (`inventory.read`) lists, per branch, where the batch came from (receipts, transfers, openings), where it went (sales with number, date, quantity, customer if any, prescription id if any; returns; write-offs; transfers out; openings into pieces, followed down the chain) and what is left. From `stock_lot_movements`, no new ledger.
- **Holds** (recalls, FDA advisories): `lot_holds` (variant, lot code, all branches or one, reason, reference, placed by/at, released by/at with reason). One open hold per (variant, lot code, branch scope). A held lot is not sellable at BLOCK branches (§4) and shows on the expiry list as "On hold"; writing it off or returning it to the supplier works as usual. Routes `POST /v1/stock/lot-holds`, `POST /v1/stock/lot-holds/:id/release` (`inventory.adjust`, Idempotency-Key, audited). Holds are operational rows (released, never deleted).
- **Receipt**: each drug line prints "Lot <code> · Exp <MM/YYYY>" for the lots its sale movements drew (read after the movements are written; several lots → several short lines). An offline receipt printed by the till leaves it out; a reprint from the server has it.

### 6. Prescriptions
- `prescriptions` (branch, optional `customer_id`, patient name, patient address (required for dangerous drugs), prescriber name, prescriber PRC licence no., prescriber S2 licence no. (dangerous drugs), yellow-form serial no. (dangerous drugs), issued on, notes, recorded by/at, voided at/by/reason). Created at the till during the sale or in the admin beforehand (a refill later picks it up). Editable only until its first fill; afterwards it can be voided only when nothing is filled.
- `prescription_items` (prescription, generic name, strength, dosage form, quantity prescribed, `drug_class`, directions). Prescriptions are written in generic names; any brand with the same `generic_key` fills the item (the pharmacist may dispense a generic equivalent).
- `prescription_fills` (append-only, `app_forbid_mutation`): item, sale line, quantity (+ dispensed, − returned), dispensed by (membership), at. Per-item advisory lock; a trigger refuses Σ fills above the quantity prescribed or below zero. A **dangerous-drug** item is filled once, in full (assumption: no partial fills of a yellow prescription); Rx and antibiotic items may be filled in parts (refills).
- **At the sale** (`record()`, all checkout entry points): every line whose product `drug_class` is RX, ANTIBIOTIC or DANGEROUS needs `prescription: { prescriptionId | ref, itemId | itemRef }` — an existing prescription of the same legal entity (any branch) or one created in the same request (`prescriptions: [...]` with client refs, like beneficiaries). Checked: not voided; the item's `generic_key` matches the product's; quantity ≤ what is left; dangerous drugs need the S2 and yellow-form numbers and the patient address. 422 `PRESCRIPTION_REQUIRED` / `PRESCRIPTION_MISMATCH` / `PRESCRIPTION_EXCEEDED`. OTC lines take none.
- **Who dispenses**: Rx and antibiotic lines need `pharmacy.dispense`; dangerous drugs need `pharmacy.dangerous_drugs`, and the dispensing member must have a pharmacist licence in force on record (*as built:* a `pharmacist_licenses` row per membership, number and validity, set with `pharmacy.setup`, audited by field name). When the cashier lacks the permission, a pharmacist approves at the till with their credentials (`AuthService.verifySecondPerson`, as for price overrides); the fill records the approving pharmacist as `dispensed_by`.
- **Returns** of a filled line write a negative fill (the item can be filled again). Voids likewise.
- *As built:* a fill made offline beyond what was prescribed is recorded with `needs_review` (the trigger lets only those exceed); a prescription recorded with a sale that no line fills is refused online (`PRESCRIPTION_UNUSED`); the check order is the lines first (`PRESCRIPTION_REQUIRED` / `MISMATCH` / `EXCEEDED`), then who dispenses.
- **Offline**: Rx and antibiotic lines are allowed; the envelope carries a prescription recorded at the till (the snapshot carries no patient data, so offline refills of an earlier prescription are not possible). Recorded by `recordOffline`; a failed check (exceeded, mismatch, missing) is **recorded and flagged** `PRESCRIPTION_REVIEW` for the pharmacist, never refused. Dangerous drugs: the till refuses offline and the server **quarantines** an envelope carrying one.
- Prescriptions are personal **health** data: audit by id only, never values; exported with the tenant; a row in `processing-register.md` and `retention-schedule.md` (retention is the pharmacist's and the DPO's decision, G6). Anonymising a customer unlinks `customer_id` (allowed by the trigger in every state, voided too) but keeps the prescription as a dispensing record until its retention ends (DPO to confirm).

### 7. Box, strip, piece — pack chains at the sale
*Kept (2026-10-25) for every shop.*
- `pack_conversions` already allows a pack of a pack (no loops). `openPacksForSale` now walks up: when the pieces are short and the pack above (strip) has too few sellable whole units, it first opens enough of the next pack up (box) to supply the strips, then the strips for the pieces. At most **3 levels** (piece, strip, box, case). Each opening is its own `pack_openings` document with the `sale_id`, in the sale's transaction, before the sale's movements.
- Every balance in the chain is locked first, in variant order, in one call (`app_lock_stock_balances`), so concurrent sales cannot open the same box twice.
- Lots flow down the chain (pieces take the strip's dates, which took the box's). Under BLOCK, only sellable (unexpired, unheld) packs are opened, and expired pieces are not counted as available.
- The till shows the chain on the item ("1 box = 10 strips = 100 tablets") and the price per level comes from each item's own price, as today.

### 8. SC/PWD on medicines
- `sale_beneficiaries.purchase_booklet` (boolean, null when the discount covers no drug line): whether the booklet was presented and filled in. Whether it is required is a per-business setting `pharmacy_settings.require_purchase_booklet` (default **true**, assumption to be checked: rules on the booklet have changed over the years); when required, an SC/PWD discount on a drug line without it is refused with 422 `PURCHASE_BOOKLET_REQUIRED`. (*As built:* offline envelopes carry no SC/PWD beneficiaries, so there is nothing to flag offline.)
- A discounted Rx/antibiotic line still needs its prescription (§6): one record serves both rules.
- The receipt already prints name, ID number, TIN and the signature line; it adds "Booklet presented" and, per drug line, the generic name (§3).
- The SC/PWD book report gains generic name, strength, quantity and prescription reference columns for drug lines (CSV too).

### 9. Permissions and roles
- New codes: `pharmacy.read` (prescriptions and the books), `pharmacy.dispense` (Rx and antibiotics), `pharmacy.dangerous_drugs` (privileged: MFA), `pharmacy.setup` (pharmacy settings, licence numbers).
- Roles for PHARMACY and HYBRID businesses: **Pharmacist** (sales, dispense, dangerous drugs, pharmacy read, inventory read/adjust/count, customers read) and **Pharmacy assistant** (sales, pharmacy read, inventory read/count; Rx needs a pharmacist's approval). Owner/admin get all four codes; the back-fill adds them to built-in roles of existing PHARMACY/HYBRID businesses (none yet besides HYBRID).

### 10. Reports (CSV in the admin)
- **Prescription book**: every fill in a period and branch — date, sale no., patient, prescriber and licence, generic, brand, strength, quantity, pharmacist; voided and returned fills shown.
- **Dangerous drugs book**: per dangerous drug and branch, for a month — opening, received (with lot), dispensed (with yellow-form no., patient, prescriber S2), returned, written off, closing; from stock movements and fills, matching the stock balance.
- **Expired and held stock**: the expiry list (ADR-0020) gains held lots and a "sold while expired" section (offline flags).
- **Batch trace** (§5) as a screen with CSV.

### 11. Admin and till
- Admin: drug section on the product form (class, generic, strength, form, FDA reg. no.); a **Pharmacy** band tab for PHARMACY/HYBRID (Prescriptions list/detail/new/void, the two books, batch trace and holds); expired-stock rule in inventory settings; pharmacist licence on members; pharmacy settings (booklet); guide part; role group; BFF paths.
- Till: generic search and badges, Equivalents, the prescription panel on Rx lines (new prescription or the customer's open ones online), pharmacist approval, the booklet tick with SC/PWD, `EXPIRED_STOCK` message, chain display, receipt lines, guide lines.

## Consequences
- New tables (as built): `prescriptions`, `prescription_items`, `prescription_fills`, `dispense_approvals`, `lot_holds`, `pharmacy_settings`, `pharmacist_licenses`. New columns: `products.generic_name|strength|dosage_form|drug_class|fda_registration_no|generic_key`; `inventory_settings.expired_stock`; `stock_lot_movements.expired`; `sale_beneficiaries.purchase_booklet`; `sale_lines.drug_class|drug_label`. Function `app_lot_held` (platform-owned). Each new tenant table follows the usual rules (RLS ENABLE+FORCE, composite FKs, grants, worker export grant, isolation fixtures and `:id` attack cases).
- `app_track_stock_lots` is replaced (draw order at BLOCK branches, `expired_lot`); `openPacksForSale` walks chains; `record()` gains the expired check, the prescription fills and the booklet rule.
- No new ledger accounts or postings: prescriptions and holds are records, sales post as today.
- Privacy pack: prescriptions (health data) and the pharmacist licence number in the register and retention schedule; `PERSONAL_KEYS` gains the new field names.
- Tests: new `pharmacy.test.ts` (expired refusal and draw order, offline flag, holds, lot code rule, trace, prescriptions by class incl. dangerous offline quarantine, approval, partial and over fills, returns, chains with concurrency, booklet, equivalents, reports), isolation, rls-catalog, ledger unchanged, `test:e2e:web:pharmacy`, `test:e2e:pos:pharmacy`.

## Not covered (LEFTOVER when built)
- Maximum drug retail prices (MDRP, EO 104 and later lists): no price ceiling check.
- e-Prescriptions, FDA eServices or DDB online reporting; the books are for printing and filing.
- Photos or scans of prescriptions (needs file storage, D1).
- Choosing the lot at the till; cost per lot.
- Refill reminders to customers.
- Compounding and repacking records.
