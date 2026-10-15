# ADR-0005: UUIDv7 identifiers and exact-decimal money

- Status: Accepted (2026-10-15)

## Decision
- Primary keys: UUIDv7 (time-ordered, index-friendly, generatable offline on terminals). Postgres 18 `uuidv7()` is the column default; terminals generate their own for offline documents.
- Money: `NUMERIC(20,4)` in the database plus an explicit `currency char(3)` column on every monetary document. Line-level unrounded values are allowed at 4 dp; document totals are rounded to the currency's minor units by the tax/pricing policy.
- Quantities: `NUMERIC(18,4)`.
- Rates (tax, discount %): `NUMERIC(9,6)`.
- TypeScript: `@1pos/money` (decimal.js clone with 40-digit precision). JS `number` is rejected at the boundary.
- Wire format: decimal **strings** (`"123.45"`), never JSON numbers.
- Rounding: HALF_UP by default; configurable per legal entity tax profile; recorded in each sale's tax snapshot.
- Allocation (split bills, prorated discounts, refund proration): largest-remainder method guaranteeing parts sum to the total.
