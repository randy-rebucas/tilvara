# ADR-0023: Hotels, resorts and transient houses — rooms, stays, folios, room charges, deposits

- Status: Accepted (2026-10-21, session 28). The user asked for the "Hospitality & Lodging" industry (`docs/INDUSTRIES.md`). They chose (the recommended option each time) a light property management system built in **plus** a read API and webhooks for a hotel that already has a PMS, outlet sales recorded at once with a *Charge to room* tender, room nights charged **each night automatically** (night audit), and all four extras: booking deposits, a guest registry, a local accommodation tax, a housekeeping board.
- SPEC §6.3 (checkout), §6.9 (customers), §12 (privacy). Builds on ADR-0009 (checkout), ADR-0010 (payment intents), ADR-0011 (returns), ADR-0013 (ledger), ADR-0014 (restaurant checks, `createFromBill`), ADR-0018 (customers), ADR-0019 (API keys, webhooks), ADR-0022 (business type pattern, GiST no-double-booking, Front Desk role).

## Review (before this ADR)
- There: customers with consent, SERVICE items, restaurant/bar checks, a service charge, tips, payment intents, API keys (GET only) and webhooks, the GiST no-double-booking pattern (appointments).
- Missing: a lodging business type, rooms and room types, bookings over dates, check-in/out, a guest folio that collects charges from outlets, a receivable for guests in the books, deposits, nightly room charges, a guest registry, housekeeping.

## Decision

### 1. A sixth business type, LODGING ("Hotel, resort or transient house")
- `tenants.business_type` takes `LODGING`. A new rule `servesLodging(type)` is true for LODGING and HYBRID: rooms, stays, folios, housekeeping and the lodging roles. Other types get `BUSINESS_TYPE_EXCLUDES_FEATURE` on lodging writes (reads stay open, as for appointments).
- `servesTables(LODGING)` is **true**: a resort's restaurant, bar and room service are the main source of room charges. Table service still needs the plan's `restaurant` feature. A transient house with no restaurant simply does not set up tables.
- Trial samples: two room types (Standard, Family) with a few rooms, a minibar item, laundry and breakfast services. The guide gets a part "Rooms, stays and folios".

### 2. Room types and rooms
- `room_types` (tenant-wide: code, name, base and max occupancy, a SERVICE **room-night variant** `night_variant_id`, archived). The room night is an ordinary catalog item: its **branch price** is the room type's rack rate per night; its tax category decides VAT; price lists and scheduled prices work as for any item. The item is never stock-tracked.
- `rooms` (branch, room type, number/name unique per branch among active, floor, notes, archived, `housekeeping_status` §9).
- Setup needs a new permission `lodging.setup` (owner, admin, branch manager).

### 3. Stays (bookings) — no double-booking
- `stays` (branch, legal entity of the branch, room, room type, customer or a guest name, `arrival_date`, `departure_date` (dates in the branch's calendar, departure > arrival), adults, children, status, `nightly_rate` (agreed gross rate per the entity's price display, null = the branch price of the room night in force on each night), `allow_charges` (default true), `charge_limit` (null = none), source (WALK_IN, PHONE, ONLINE, OTA, OTHER), external reference, notes, who booked, checked-in/out at and by, cancelled reason).
- Statuses: `BOOKED` → `IN_HOUSE` (checked in) → `CHECKED_OUT`; or `CANCELLED` / `NO_SHOW` (with a reason). A state-machine trigger refuses other moves.
- **No double-booking**: GiST exclusion on (tenant, room, `daterange(arrival_date, departure_date)`) where `active` (BOOKED or IN_HOUSE). 23P01 → 409 `ROOM_DOUBLE_BOOKED`. Cancel and no-show clear `active`. Moving a guest to another room, extending or shortening a stay are `PATCH`es (audited) re-checked by the constraint.
- A rate other than the rack rate needs `prices.manage` or the new `lodging.rates` (front desk managers); the stay records it.
- **Availability**: `GET /v1/lodging/availability?branchId&from&to[&roomTypeId]` lists free rooms per night and per room type.
- Stays are operational records (edited, audited), not books. Their folio (§5) is the financial record.

### 4. Check-in, check-out
- **Check-in** (`POST /v1/stays/:id/check-in`): BOOKED, arrival date ≤ today (branch calendar; an early check-in the day before is allowed), the room CLEAN or INSPECTED unless `overrideHousekeeping` (audited), at least the primary guest in the registry (§8). Opens the folio. Walk-ins: create and check in in one call (`POST /v1/stays` with `checkIn: true`).
- **Check-out** (`POST /v1/stays/:id/check-out`): posts every night still due up to the departure date (shortening the stay to today first if the guest leaves early, `departEarly: true`), applies deposits held (§6), and refuses with 409 `FOLIO_BALANCE_DUE` while the folio balance ≠ 0. The front desk settles first (§5). Sets the room DIRTY. A late check-out fee is an ordinary charge.
- No-show: a BOOKED stay whose arrival day has passed may be marked NO_SHOW; deposits follow the forfeit rule (§6).

### 5. Folios — the guest ledger
- One `folios` row per stay (opened at check-in or at the first deposit), legal entity of the branch, status OPEN → SETTLED (at check-out; a settled folio takes no more entries).
- `folio_entries` (append-only, `app_forbid_mutation`): `kind` and signed `amount` (+ = the guest owes more):
  - `ROOM_NIGHT` (+): one per (stay, night date) — **unique** — with its tax breakdown (§7) and the accommodation tax as a separate `ACCOMMODATION_TAX` entry (+).
  - `CHARGE` (+): an outlet sale tendered *Charge to room* (§5.1), referencing the sale.
  - `CHARGE_RETURN` (−): a return/void of such a sale while the folio is open, referencing the return.
  - `DEPOSIT_APPLIED` (−): deposits moved onto the folio (§6).
  - `PAYMENT` (−): a settlement at the front desk (§5.2), referencing a `folio_payments` row.
  - `ADJUSTMENT` (±, reason, `lodging.rates`): a goodwill credit or a manual fee, VAT computed by `@1pos/tax` like a room night (a credit reverses the share of revenue and VAT).
  - `NIGHT_REVERSAL` (−): undoes a ROOM_NIGHT (wrong night after a date change), linked to it once.
- Balance = Σ amounts. An insert trigger takes a per-folio advisory lock (the API takes it first). A charge beyond `charge_limit` or on a stay with `allow_charges = false` is refused (409 `ROOM_CHARGE_LIMIT` / `ROOM_CHARGES_NOT_ALLOWED`).
- **Books**: the guest ledger is a new asset *1150 Guest ledger* (`GUEST_LEDGER`). Every entry posts through `post()` in the same transaction (rules in `@1pos/accounting`):
  - ROOM_NIGHT: Dr Guest ledger / Cr *4100 Room revenue* (`ROOM_REVENUE`) ex VAT, Cr Output VAT, (SC/PWD: Dr SC/PWD discounts as for sales).
  - ACCOMMODATION_TAX: Dr Guest ledger / Cr *2120 Accommodation tax payable* (`ACCOMMODATION_TAX_PAYABLE`).
  - CHARGE: no entry of its own — the sale's posting debits Guest ledger for the room-charge tender instead of cash.
  - CHARGE_RETURN: the return's posting credits Guest ledger instead of refunding cash.
  - DEPOSIT_APPLIED: Dr *2320 Guest deposits* / Cr Guest ledger.
  - PAYMENT: Dr Cash on hand / Card/QR clearing / Customer store credit / Cash in bank / Cr Guest ledger.
  - ADJUSTMENT / NIGHT_REVERSAL: the mirror of a room night.
- `ledger.test.ts`: GL *1150* = Σ folio entries; GL *2320* = Σ deposits held.

#### 5.1 Charge to room (outlets)
- A new tender `{ method: 'ROOM_CHARGE', stayId }` on `POST /v1/sales` and on restaurant checks (`createFromBill`). Rules: the stay is IN_HOUSE, of the **same legal entity** as the sale (any branch of it: a resort's restaurant may be another branch), charges allowed and within the limit; at most one ROOM_CHARGE tender per sale; it gives no change. `record()` writes the `CHARGE` folio entry in the same transaction; the sale's tender row has `method = 'ROOM_CHARGE'` and `stay_id`.
- The till picks an in-house guest by room number and checks the name with the guest (`GET /v1/stays/in-house?branchId&q=` for the legal entity, `sales.create`). The receipt prints "Charged to room 204 — <guest surname>" and a signature line.
- Returns: a return of a room-charged sale while the folio is OPEN refunds onto the folio (`CHARGE_RETURN`); once settled, refunds as today (cash from the drawer).
- **Offline**: refused (the offline till cannot check the stay); the till hides the tender offline. An offline envelope with ROOM_CHARGE is quarantined.

#### 5.2 Settling a folio (front desk)
- `POST /v1/folios/:id/payments` at an **open cashier session** (the front desk works a drawer, `cash.session` + `lodging.manage`): tenders CASH (with change), INTENT (card/QR via payment intents, consumed once), STORE_CREDIT (the stay's customer), or BANK_TRANSFER (reference; `lodging.rates` — no drawer effect). Writes a `folio_payments` row (append-only, session, register, method, amount, intent, reference) and the `PAYMENT` entry. Required Idempotency-Key, through `TenantService.mutate()`.
- Cash folio payments and cash deposits **count in the drawer's expected cash** (`expectedCash`) and are listed apart in the session report ("Front desk collections"). They are not sales: sales and Z-reading totals do not include them.
- A payment may exceed the balance only for CASH (change). Overpayment by other methods is refused.
- `GET /v1/folios/:id` and `/statement` give the folio with entries; the statement prints "Guest folio — not an invoice" while invoicing is DISABLED.

### 6. Booking deposits
- `stay_deposits` (append-only): `RECEIVED` (+, method as §5.2 incl. BANK_TRANSFER, session if cash), `APPLIED` (−, onto the folio), `REFUNDED` (−, cash from an open drawer or a bank transfer reference), `FORFEITED` (−). Balance per stay ≥ 0 (trigger, per-stay lock).
- Books: RECEIVED Dr Cash/Clearing/Bank / Cr *2320 Guest deposits* (`GUEST_DEPOSITS`); FORFEITED Dr Guest deposits / Cr *4110 Cancellation fees* (`CANCELLATION_INCOME`) ex VAT + Cr Output VAT (computed by `@1pos/tax` with the room night's tax category); REFUNDED Dr Guest deposits / Cr Cash/Bank.
- A deposit is held **without VAT** until it is applied to room nights or forfeited (treated as a refundable deposit) — **pending the accountant** (with store credit, tips and packages).
- Cancelling or a no-show: the request says `forfeit` (default per the branch's `lodging_settings.forfeit_on_cancel`) or `refund`; `lodging.rates` to refund against the default.
- Check-in may apply deposits early; check-out always applies what is left.

### 7. Room nights — the night audit
- The night of date *D* is charged on the folio of every IN_HOUSE stay with arrival ≤ D < departure. Its price: the stay's `nightly_rate`, else the room-night variant's branch price in force at the start of *D* (DB clock rules, `effectiveNowSql`), VAT and SC/PWD computed by `@1pos/tax` through `TaxService` (the same engine and tax profile as the quote path; the agreed rate is the line's unit price, like an approved price). The entry keeps net, VAT, rate snapshot and tax category snapshot.
- **SC/PWD** (RA 9994 / RA 10754 cover hotels): a stay may carry beneficiaries (`stay_beneficiaries`: scheme, name, ID number, share = 1 ÷ guests in the room by default) and each night applies the statutory discount to their share, as a sale line does. Pending professional review like the rest of SC/PWD.
- **When**: each branch has `lodging_settings.night_audit_time` (default 03:00 local): night *D* is due once the branch's clock passes *D + 1* at that time. Check-out posts every night still due regardless of the time.
- **Who runs it**: the API process runs `NightAuditScheduler` every 10 minutes (`NIGHT_AUDIT_INTERVAL_MS`, 0 = off; tests set 0). It takes `pg_try_advisory_lock` so one instance runs, lists the tenants with due nights through the SECURITY DEFINER `platform_lodging_due_tenants()` (granted to `onepos_app`), and for each tenant posts inside `withTenant` (audit actor = system). A read-only business (lapsed) is skipped; its nights stay due and are posted when it becomes writable (every night is identified by its date, so catch-up is exact). `POST /v1/lodging/night-audit` (`lodging.manage`, branch) runs it now for a branch. The posting is idempotent: (stay, night) is unique and the API takes a per-folio lock.
- Journal date of a night = the night. If that period is closed, the entry is dated the first open day after it (recorded on the entry).

### 8. Guest registry
- `stay_guests` (stay, primary flag, full name, nationality, ID type, ID number, address, birth date optional, contact optional): what the front desk records at check-in for the registration card (`GET /v1/stays/:id/registration-card`, printable). Personal data: rows in `processing-register.md` and `retention-schedule.md`, exported with the tenant, deleted when the linked customer is anonymised; audit rows name changed fields, never values. Logging: the new field names go in `PERSONAL_KEYS`.

### 9. Housekeeping
- `rooms.housekeeping_status`: `CLEAN`, `DIRTY`, `INSPECTED`, `OUT_OF_ORDER` (with reason; an out-of-order room cannot be booked for the dates given in `room_blocks`, which take part in the same exclusion as stays). Changes are `room_status_changes` rows (append-only: from, to, by, at, note) so the board shows who cleaned what. Check-out sets DIRTY.
- Permission `lodging.housekeeping` (housekeeping board, status changes). Role templates (lodging and HYBRID only): **Front Desk** gains the lodging codes for a LODGING business (one template, both industries), **Housekeeping** (`lodging.read`, `lodging.housekeeping`), and branch managers get `lodging.setup`, `lodging.rates`.

### 10. Local accommodation tax
- `lodging_settings.accommodation_tax_rate` per branch (0–0.2, null = off, default off) on the room night's net ex VAT, not subject to VAT, shown as its own folio line and posted to *2120 Accommodation tax payable*. Some LGUs levy a tax on room charges; the rate and base must be confirmed with a tax adviser for each place (**unverified**). Report "Accommodation tax" per branch and month.

### 11. Permissions
New codes: `lodging.read` (board, stays, folios), `lodging.manage` (book, change, check in/out, settle, deposits, night audit now), `lodging.rates` (agreed rates, adjustments, bank transfers, refund against the default), `lodging.housekeeping`, `lodging.setup` (room types, rooms, settings). Owner/admin all; branch manager all; cashier and senior cashier `lodging.read` (to find in-house guests: room charges need only `sales.create`); accountant `lodging.read`. Migration grants them to existing built-in roles and adds Housekeeping to existing HYBRID businesses; a business that changes to LODGING gets them then.

### 12. Reports
- **Occupancy and room revenue** (`/v1/reports/occupancy`): per day and branch: rooms available (active, not out of order), rooms sold, occupancy %, room revenue ex VAT, ADR, RevPAR.
- **Guest ledger** (`/v1/reports/guest-ledger`): open folios with balance per legal entity, beside GL 1150; **Deposits held** beside GL 2320.
- **Accommodation tax** (§10).
- Room nights take part in the **tax summary** and the **sales summary** as a "Rooms" source (net, VAT, SC/PWD), and SC/PWD room nights in the SC/PWD sales book, so VAT reports are complete. Sales by product / cashier / tender do not change (room nights are not sales).
- All under `reports.read`; occupancy and guest ledger are everyday reports (every plan).

### 13. External PMS (integration)
- API keys (ADR-0019, GET only) gain the scope `lodging` → `lodging.read`: `GET /v1/stays`, `/v1/stays/:id`, `/v1/folios/:id` (entries), `/v1/rooms`.
- Webhook topics (`WEBHOOK_TOPICS`, ids only): `stay.checked_in`, `stay.checked_out`, `folio.entry_posted` (with `folioId`, `entryId`, `kind`). A PMS that keeps its own folios pulls Tilvara's room charges from these.
- Not covered: writing to Tilvara from a PMS (needs write-scoped keys, a decision), channel managers (Booking.com, Agoda), a public booking page.

## Consequences
- New tables: `room_types`, `rooms`, `room_blocks`, `room_status_changes`, `lodging_settings`, `stays`, `stay_guests`, `stay_beneficiaries`, `stay_deposits`, `folios`, `folio_entries`, `folio_payments`. New columns: `sale_tenders.stay_id` (+ method `ROOM_CHARGE`). System accounts `GUEST_LEDGER` 1150, `ACCOMMODATION_TAX_PAYABLE` 2120, `GUEST_DEPOSITS` 2320, `ROOM_REVENUE` 4100, `CANCELLATION_INCOME` 4110 (seeded for new entities, back-filled for existing ones). Permissions §11. Webhook topics §13. Business type LODGING.
- Every new tenant table follows the tenant rules (composite FKs, ENABLE + FORCE RLS, grants for `onepos_app` and `onepos_worker`, fixtures in `isolation.test.ts`, `rls-catalog.test.ts`). `folio_entries`, `folio_payments`, `stay_deposits`, `room_status_changes` are append-only.
- Online only: the offline till sells as before but has no Rooms tab and no room-charge tender.

## Not covered (LEFTOVER)
- Group bookings (several rooms on one booking, a master folio), splitting a folio, moving charges between folios.
- Writes from an external PMS, channel managers, a public booking page, online payment of deposits.
- Room service as an order type (today a waiter rings a check and charges it to the room).
- Dynamic rates (seasons, weekends, rate plans) beyond scheduled prices and an agreed rate per stay.
- Per-person environmental fees (a fixed amount per guest per night).
- The VAT timing of nightly room charges vs. the invoice issued at check-out, and deposits without VAT: accountant.
