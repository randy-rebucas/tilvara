# ADR-0022: Beauty salons, spas and barber shops — staff, appointments, service packages, client history

- Status: Accepted (2026-10-21, session 27). The user asked for the "Beauty Salons, Spas & Barber Shops" industry (`docs/INDUSTRIES.md`). They chose (the recommended option each time) a service-staff list that need not sign in, prepaid packages owed until used, booking by staff only (no public page), and all four extras: supplies used per service, commissions, tips per staff and email reminders.
- SPEC §6.3 (checkout), §6.6 (stock, low-stock alerts), §6.9 (customers), §12 (privacy). Builds on ADR-0009 (checkout), ADR-0011 (returns), ADR-0013 (ledger), ADR-0014 §4 (recipes), ADR-0018 (customers, store credit), session 17 and ADR-0020 (business types), session 25 (tips).

## Review (before this ADR)
- There: `SERVICE` products (never stock-tracked), customers with purchase history, notes, consent and store credit, reorder points and `stock.low` mails, recipes consuming stock at checkout, tips.
- Missing: a salon type, an appointment calendar, staff who perform services, service packages, a client's service history, supplies used by a service (recipes were restaurant-only), commissions, tips per staff.

## Decision

### 1. A fifth business type, SALON ("Salon, spa or barber shop")
- `tenants.business_type` takes `SALON`. Like RETAIL it does not serve tables (`servesTables` is false: no tables, menus or kitchen, no restaurant roles).
- A new rule, `servesAppointments(type)`, is true for SALON and HYBRID: appointments, service staff, packages and the salon role templates. The server refuses appointment and staff writes for other types with `BUSINESS_TYPE_EXCLUDES_FEATURE` (reads stay open, as for restaurant service).
- Recipes ("supplies used") are open to SALON without the plan's `restaurant` feature (`usesRecipes(type)` = serves tables or SALON).
- Trial samples: a few services (haircut, colour, manicure, massage) and two retail items. The guide gets a part "Appointments, packages and staff".

### 2. Service staff
- `service_staff` (branch, display name, optional link to a member, default commission rate 0–1, calendar colour, archived): the people who perform services, whether or not they sign in. Personal data (name only).
- `service_staff_services` (staff, service variant, optional commission rate): what they do. No rows = every service.
- `service_staff_hours` (staff, weekday 0–6, start and end time in the branch's calendar; several per day for split shifts, never overlapping) and `service_staff_time_off` (from, until, reason).
- Managed with a new permission `staff.manage` (owner, admin, branch manager). Listed with `appointments.read` or `sales.create` at the branch (the till names staff on lines). The front desk (`appointments.manage`) may also record and remove time off.
- No hours set = the staff member can be booked any time of the branch day (the business has not planned shifts); time off still applies. Free-time suggestions for them stay within 08:00–20:00.

### 3. Services are booked by duration
`product_variants.service_minutes` (5–720): how long the service takes. Only a SERVICE item with a duration can be booked.

### 4. Appointments
- `appointments` (branch, customer or a guest name, `starts_at`/`ends_at` spanning its services, status, notes, `remind`, `reminded_at`, `sale_id`, who booked it). Statuses: `BOOKED` → `ARRIVED` → `COMPLETED` (rung up), or `NO_SHOW` / `CANCELLED` (with a reason).
- `appointment_services` (position, service variant, staff, `starts_at`, `ends_at`, `active`). **No double-booking**: a GiST exclusion constraint on (tenant, staff, time range) where `active`. Cancelling or a no-show clears `active`, freeing the time. The constraint is the guard; the API answers 409 `STAFF_DOUBLE_BOOKED`.
- Booking outside the staff's hours or in their time off is refused (`OUTSIDE_WORKING_HOURS`) unless the request says `outsideHours: true` (front desk squeezing someone in); a staff member who does not do the service is refused (`STAFF_DOES_NOT_DO_SERVICE`).
- Changing an appointment (`PATCH`, while BOOKED or ARRIVED) replaces its services. Every change is audited. Appointments are operational records, not books: they are edited, not append-only.
- Permissions: `appointments.read` (calendar), `appointments.manage` (book, change, mark arrived, no-show, cancel). Role templates (salon and HYBRID types only): **Front Desk** (cashier + appointments and customers), **Stylist** (appointments.read, catalog.read, customers.read). The cashier, senior cashier, branch and restaurant manager templates gain the appointment codes (and branch managers `staff.manage`) for every type; migration 0099 grants them to existing built-in roles and adds Front Desk and Stylist to existing HYBRID businesses; a business that changes to SALON gets them then.
- **Ringing up**: `POST /v1/sales` with `appointmentId`. `record()` checks the appointment is BOOKED or ARRIVED at the sale's branch and not rung up, and marks it COMPLETED with the sale's id in the same transaction (`appointments_sale_once`). The till fills the cart from the appointment (services, staff, customer); the cashier may change it. A void does not reopen the appointment.
- Online only (the till's Appointments tab needs the server).
- **Free times**: `GET /v1/appointments/availability` lists, per staff member who does the service, every start on a 15-minute step at which the whole service fits in their hours, outside time off and bookings, and not in the past.

### 5. Staff on the sale, commissions
- `sale_lines.service_staff_id` and `sale_lines.commission_rate` (the rate in force at the sale: the staff's rate for that service, else their default). Any line may name a staff member of the sale's branch (services and retail items they sold). Offline: the snapshot carries the branch's active staff; an offline line naming an unknown staff member is refused (quarantined), an archived one is accepted (they did the work).
- **Commission** = rate × the line's ex-VAT sales (for a package session, the value it turned into sales, §6), less returns pro rata. Report "Commissions" (`/v1/reports/commissions`, `reports.read`) per staff with lines, sales and commission, CSV. Commissions are a report, not a payable: payroll is outside Tilvara.

### 6. Service packages (owed until used)
- `products.product_type` takes `PACKAGE` (never stock-tracked). Contents: `service_package_items` (package variant, service variant, sessions). `product_variants.package_valid_days` (null = no expiry).
- **Selling**: a package line needs a customer on the sale, a whole quantity, no SC/PWD (a promotion or a cashier's discount may apply; the value owed is what was paid ex VAT). Each unit becomes a `customer_packages` row (customer, legal entity, sale line, `expires_on`, value) with `customer_package_items` copied from the contents. The package's ex-VAT net is the **value owed**: it is split over the items in proportion to each service's list price × sessions at the sale (largest remainder to the centavo).
- **Books**: a package line's ex-VAT credits a new liability *2310 Prepaid service packages* (`PREPAID_SERVICES`) instead of Sales; its VAT is output VAT at once (VAT on services is due on what is received). Seeded for new entities, back-filled for existing ones. Pending the accountant (as store credit and tips).
- **Using a session**: a sale line with `packageId` for a service the package holds. It is priced at zero (no VAT), needs the package's customer on the sale and the same legal entity, an unexpired package and sessions left. Each session turns value into sales: what is left of the item's value ÷ the sessions left (to the centavo; the last session takes the rest). `sale_lines.customer_package_id` and `package_value` record it; the sale posts *Dr Prepaid service packages / Cr Sales* for it.
- `customer_package_entries` (append-only): `SOLD` (+sessions), `REDEEMED` (−), `RESTORED` (+, a return or void of a redeeming sale), `REFUNDED` (−, a returned package). An insert trigger takes a per-package advisory lock (the API takes it first) and refuses a balance below zero. Two tills using the last session: one wins, the other gets 409 `PACKAGE_EXHAUSTED`.
- **Returns**: a returned package line cancels whole unused packages of that line only (409 `PACKAGE_USED` otherwise; a package whose used sessions all came back counts as unused). The liability goes down by exactly the recorded value of the packages given back; any centavo between that and the return's prorated ex-VAT amount goes to Sales returns. Returning a redeeming line gives the session back (`RESTORED`) with its share of the value (the last one takes the exact rest) and moves it from Sales returns back into the liability.
- Restaurant checks never sell packages (a bill line is recorded as an ordinary sale line); keeping package items off menus is LEFTOVER.
- **Reports**: sales reports count a package when it is sold (what the customer paid); the books count sales when its sessions are used. The Service packages report shows both sides and what is still owed beside the ledger account.
- Online only: the offline till refuses package items and sessions (it cannot check a balance).
- Report "Service packages": sold, used, refunded and owed per legal entity, with the customers' open packages.

### 7. Tips per staff
- `sale_tip_shares` (tip, staff, amount); the shares add up to the tip (deferred constraint trigger). The request may give the shares; otherwise the server splits the tip equally among the distinct staff on the sale's lines (largest remainder in line order). A sale without staff keeps an unassigned tip, as before.
- The tips report adds "by staff". Paying tips out of the drawer stays one amount (not per staff).

### 8. Client history
- `GET /v1/customers/:id/visits`: appointments and service lines (with staff) newest first, with the customer's packages and sessions left.
- `customer_notes` (body, pinned, author, edited): colour formulas, preferences, allergies. Read with `customers.read`, written with `customers.manage`; audited by id, never the text. Notes can hold health information (allergies), sensitive personal information under the DPA: the processing register and retention schedule say so, the admin shows a short notice, the export includes them and anonymising deletes them.

### 9. Supplies used per service, low-supply alerts
- Recipes (ADR-0014 §4) for SALON: a service's recipe consumes its supplies (`CONSUMPTION` movements of the sale), a package session too. Supplies are ordinary tracked items; reorder points and the `stock.low` mail (session 16) give the low-supply alerts.

### 10. Email reminders
- `appointments.remind` (ticked by default when the customer has an email). The worker's hourly pass calls `platform_flag_appointment_reminders()`: a BOOKED appointment starting within 24 hours and more than an hour away, not yet reminded, with an active customer who has an email, is marked once (`reminded_at`) and gets one `appointment.reminder` outbox event (ids only). The worker mails the customer (branch, time, services, staff first names). A reminder is a service message, not marketing: it does not depend on marketing consent; untick `remind` to stop it.

## Consequences
- New tables: `service_staff`, `service_staff_services`, `service_staff_hours`, `service_staff_time_off`, `appointments`, `appointment_services`, `service_package_items`, `customer_packages`, `customer_package_items`, `customer_package_entries`, `sale_tip_shares`, `customer_notes`. New columns: `product_variants.service_minutes`, `package_valid_days`; `sale_lines.service_staff_id`, `commission_rate`, `customer_package_id`, `package_value`; `sale_return_lines` package refunds through entries. Product type `PACKAGE`. System account `PREPAID_SERVICES`. Permissions `appointments.read`, `appointments.manage`, `staff.manage`. Outbox topic `appointment.reminder`.
- `ledger.test.ts`, the isolation suite, `rls-catalog`, the data export, the processing register and the guide learn the new tables.

## Not covered
- A public booking page, deposits and online payment for bookings.
- SMS reminders (needs a provider), reminders in Filipino.
- Refunding part of a used package (only whole unused packages are returned), expiry breakage of unused sessions (accountant), moving a package to another customer.
- Paying commissions or tips out per staff; payroll.
- Rooms or chairs as booked resources (only staff are booked).
- Appointments and packages on the offline till.
