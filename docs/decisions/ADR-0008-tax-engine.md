# ADR-0008: Tax engine — versioned profiles, data-driven statutory discounts, pure calculation

- Status: Accepted (2026-10-15). **Computation rules are pending review by a qualified Philippine tax professional** (MVP gate #6, compliance gate G3). Nothing here is a compliance claim.

## Context
SPEC §12 requires versioned tax rules with effective dates, VAT / VAT-exempt / zero-rated treatments, tax-inclusive and exclusive pricing, discounts with tax-base adjustments, defined rounding, and a per-line snapshot of the rule version, taxable base and amount. It forbids a single boolean as the tax model. `docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md` §6–7 records the researched rules and their verification status.

## Decision
1. **Three inputs, all data:**
   - *Seller* — `tax_profiles`: append-only, effective-dated per legal entity (`vat_status`, `vat_rate`, `percentage_tax_rate`, `rounding_mode`, `rounding_level`). The profile in force at the sale's timestamp is the only source of truth; `legal_entities` no longer stores VAT status or rounding (migrated). A VAT registration change is a new row; profiles cannot be backdated, so a completed sale's profile never changes.
   - *Item* — `tax_categories.vat_treatment` (VATABLE / VAT_EXEMPT / ZERO_RATED), already per tenant.
   - *Buyer entitlement* — `discount_schemes`: platform-wide, versioned statutory schemes (code, rate, `vat_exempt`, base `VAT_EXCLUSIVE` | `GROSS`, `requires_id`, `review_status`). Seeded: SC (RA 9994) and PWD (RA 10754), 20 %, VAT-exempt, VAT-exclusive base. Tenants read them; only the platform changes them.
2. **`@1pos/tax` is a pure function** (no DB, no clock): `calculateTax(context, lines) → result`. The API loads data, the engine computes, the result (including the rule snapshot) is what checkout persists. The same package will run on offline terminals (Phase 5).
3. **Computation (per line, then summed):**
   - VAT seller, tax-inclusive price: `base = net / (1 + rate)`, `vat = net − base` (VAT derived by subtraction so base + VAT = amount paid exactly).
   - VAT seller, tax-exclusive price: `vat = round(base × rate)`, due = base + VAT.
   - VAT_EXEMPT / ZERO_RATED items: no VAT, amount goes to the exempt / zero-rated bucket.
   - Non-VAT seller: no VAT on any line; VATABLE-category items are *sales subject to percentage tax* (SSPT), exempt items are exempt. Percentage tax is reported, never added to the price. Zero-rated items of a non-VAT seller go to SSPT (**assumption, needs review**).
   - Statutory scheme on a line (optionally for a `share` of it, e.g. the beneficiary's portion): if the scheme is VAT-exempt and the seller is VAT-registered, VAT is removed first; the discount is `rate × base` where base is VAT-exclusive or gross per scheme; the beneficiary portion is a VAT-exempt sale. Golden vectors (compliance doc §7.1): VAT seller ₱1,120 → due ₱800 (exempt sale ₱1,000, discount ₱200); non-VAT seller ₱1,120 → due ₱896.
   - **No stacking**: a line cannot carry a statutory scheme and an ordinary discount (law: the beneficiary takes the higher one; the caller chooses). Only one statutory scheme per line.
   - **Rounding**: per line, to centavos, with the profile's mode (HALF_UP default). Totals are sums of rounded lines, so receipts, reports and ledgers always agree. Invoice-level rounding is not implemented (unverified which the BIR expects — tax-adviser question 6).
4. **Snapshots**: every line result carries `{profileId, profileEffectiveFrom, vatRate, roundingMode, schemeCode?, schemeVersion?}` plus every bucket amount; sales (next slice) persist it verbatim.
5. **Gate**: schemes with `review_status = PENDING_PROFESSIONAL_REVIEW` compute normally, but results flag `requiresProfessionalReview`; checkout will refuse them in production until the platform marks the scheme `APPROVED` after sign-off.

## Not decided / out of scope (tracked in BACKLOG)
5 % BNPC discount (cap unverified), NAAC and Solo Parent schemes (VAT treatment unverified), group-meal proration and MEMC base (restaurant phase), service charge interaction (both moot while retail-only: no restaurant checks or service charges since 2026-10-25), invoice-level rounding, withholding/ewt.

## Consequences
- Changing a rate or registration never rewrites history; reports read snapshots, not current config.
- The engine is exhaustively unit-tested without a database; integration tests check that the API feeds it the profile, price and category actually in force.
