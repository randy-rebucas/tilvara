# ADR-0024: Laundromats and laundry shops — job orders, claim tickets, down payments, machines, pickup and delivery

- Status: Accepted (2026-10-21, session 29). The user asked for the "Laundromats & Laundry Shops" industry (`docs/INDUSTRIES.md`). They chose (the recommended option each time) a job order priced at drop-off whose **sale is recorded at claim** with the down payment held as a deposit until then, **email notices now plus an SMS port** (a dev adapter until a provider is chosen), a **machine board with cycles** for self-service and drop-off loads, and all four extras: item count and condition at drop-off, express turnaround, prepaid laundry packages, supplies used per load.
- SPEC §6.3 (checkout), §6.6 (stock), §6.9 (customers), §12 (privacy). Builds on ADR-0009 (checkout, `record()`), ADR-0010 (payment intents), ADR-0011 (returns), ADR-0013 (ledger), ADR-0014 §4 (recipes) and §8 (`createFromBill`: a sale from a priced document), ADR-0015 (offline), ADR-0018 (customers), ADR-0022 (business type pattern, packages, reminders, GiST exclusion), ADR-0023 (deposits, drawer collections).

## Review (before this ADR)
- There: SERVICE items, selling by weight (`products.sold_by = 'WEIGHT'`, decimal quantities), customers with phone, email and address, recipes consuming stock at checkout, prepaid packages (SALON/HYBRID only), reminder mails from the worker, the deposit pattern (lodging), drawer collections that are not sales, GiST no-overlap constraints.
- Missing: a laundry type, job orders with a claim ticket, a status flow received → ready → claimed, down payments on a job, a sale recorded from a job at claim, "ready" notices, an SMS channel, washers and dryers and their usage, pickup and delivery trips, an unclaimed-items policy.

## Decision

### 1. A seventh business type, LAUNDRY ("Laundry shop or laundromat")
- `tenants.business_type` takes `LAUNDRY`. `servesTables(LAUNDRY)` is false. A new rule `servesLaundry(type)` is true for LAUNDRY and HYBRID: job orders, machines, trips, laundry settings and roles. Other types get `BUSINESS_TYPE_EXCLUDES_FEATURE` on laundry writes (reads stay open).
- `usesRecipes(type)` adds LAUNDRY (supplies used per load, §11). A new `usesPackages(type)` (SALON, LAUNDRY, HYBRID) replaces `servesAppointments` as the gate for selling and using packages (§10).
- Changing away from LAUNDRY is refused while jobs are open (not CLAIMED, CANCELLED or DISPOSED): 409 `OPEN_JOB_ORDERS`.
- Trial samples: Wash-dry-fold per kilo (min 3 kg), Wash per load (8 kg), Dry per load, Ironing per piece, Express surcharge, Delivery fee, detergent and fabric-conditioner sachets (tracked, with a recipe on the per-load wash), a self-service Washer 30-min and Dryer 10-min cycle, two washers and two dryers. The guide gets a part "Job orders, machines and deliveries".

### 2. Laundry services and pricing
- A laundry service is an ordinary SERVICE item. `product_variants.laundry_unit` (`KG`, `LOAD`, `PIECE`, null = ordinary item) says how a job line counts it; `laundry_min_quantity` (decimal, e.g. 3 kg) is the minimum charged; `laundry_kg_per_load` (for `LOAD`, e.g. 8) lets the till suggest loads from a weight (`ceil(weight ÷ kg per load)`, shown, editable).
- A `KG` service is `sold_by = 'WEIGHT'` (3 decimals). Job lines keep the **measured** quantity and the **billed** quantity = max(measured, minimum). Pricing, price lists, scheduled prices and promotions are those of any item, through `TaxService.computeCart` (with promotions, as the counter).
- **Add-ons** (detergent, fabric conditioner, ironing, folding, stain treatment) are ordinary lines: tracked sachets or SERVICE items. `product_variants.laundry_addon = true` puts them on the job form's quick buttons. No new pricing engine.
- **Self-service cycles**: `product_variants.machine_kind` (`WASHER`, `DRYER`) and `machine_minutes` mark a variant as a machine cycle (§7).

### 3. Job orders
- `job_orders` (branch, legal entity of the branch, `number` per branch from a sequence, printed as `J-000123`; `claim_code` 6 characters from an unambiguous alphabet; customer or a walk-in name and phone; `service_level` REGULAR/EXPRESS; `promised_at`; status; `weight_kg` total measured; `bag_count`; `special_instructions`; `condition_notes`; `fulfillment` flags `pickup_requested`, `delivery_requested`; `sale_id`; `ready_at`, `claimed_at`, `cancelled_reason`, `disposed_reason`; who received it).
- **Statuses**: `RECEIVED` → `WASHING` → `DRYING` → `FOLDING` → `READY` → (`OUT_FOR_DELIVERY` →) `CLAIMED`; from any status before CLAIMED: `CANCELLED`; from READY: `DISPOSED` (§9). The processing steps may be skipped (ironing only, dry cleaning) but never go back, except READY → FOLDING when a customer finds a problem before claiming (audited). A trigger enforces the moves. Every change is a `job_order_status_changes` row (append-only: from, to, by, at, note).
- **Lines**: `job_order_lines` (position, variant, measured quantity, billed quantity, unit price, discount, tax category, net, VAT, total, `customer_package_id`, `promotion_id`), frozen by `computeCart` when the job is created and every time its lines change (`PUT /v1/job-orders/:id/lines` before CLAIMED, `laundry.manage`, audited: a re-weigh, an add-on found while washing). The ticket shows the frozen total. Lines are operational, not books: replaced as a set, audited.
- **Items and condition** (extra): `job_order_items` (garment type from the branch's list or free text, count, note): "12 shirts, 4 pants, 1 comforter". `condition_notes` (stains, tears, missing buttons) and `special_instructions` (separate whites, no fabric conditioner) print on both tickets and show at release.
- **Express** (extra): `laundry_settings.regular_hours` (default 48) and `express_hours` (default 6) set `promised_at` from the drop-off time (editable). EXPRESS adds the branch's express item (`laundry_settings.express_variant_id`, its `laundry_unit` decides per job, kilo or load) as a line. A job past `promised_at` and not READY is **overdue** on the board and in the report.
- Routes: `POST /v1/job-orders` (Idempotency-Key, `laundry.manage`), `GET /v1/job-orders?branchId&status&q&overdue&unclaimed`, `GET /v1/job-orders/:id`, `PATCH` (instructions, notes, promised time, customer), `PUT …/lines`, `PUT …/items`, `POST …/status`, `POST …/cancel`, `GET …/ticket` (printable), `GET /v1/job-orders/lookup?number|claimCode` (the till's claim screen).
- Online only: the offline till sells self-service cycles and add-ons as ordinary items, and shows job orders as unavailable.

### 4. Claim tickets and release
- Drop-off prints two copies: the **customer stub** (number, claim code, branch, promised time, lines and total, down payment, balance, items and condition, the branch's claim policy text) and the **bag tag** (number, name, bag count, service level, instructions; no prices).
- **Release** needs the claim code (scanned from the stub's barcode or typed), or, without the stub, `laundry.release_override` with a reason (the customer's ID was checked; audited by id, the reason never names the ID number).

### 5. Down payments (deposits) and the sale at claim
- `job_order_deposits` (append-only): `RECEIVED` (+, CASH at an open drawer, INTENT card/QR with purpose `JOB_ORDER`, BANK_TRANSFER with a reference; store credit is not taken as a down payment, as for lodging deposits), `APPLIED` (−, at claim), `REFUNDED` (−, cash from an open drawer or a bank transfer reference), `FORFEITED` (−, §9). Balance per job ≥ 0 (trigger, per-job advisory lock taken first by the API). A down payment never exceeds the job's frozen total (409 `DEPOSIT_EXCEEDS_TOTAL`).
- Books: RECEIVED Dr Cash/Clearing/Bank / Cr a new liability *2330 Customer down payments* (`CUSTOMER_DOWN_PAYMENTS`, seeded for new entities, back-filled); REFUNDED the mirror; APPLIED is part of the sale's posting (below); FORFEITED Dr Customer down payments / Cr a new *4120 Forfeited down payments* (`FORFEITED_DOWN_PAYMENTS`) ex VAT + Cr Output VAT computed by `@1pos/tax` with the job's main service's tax category. Held **without VAT** until applied or forfeited — **pending the accountant** with store credit, tips, packages and lodging deposits. The deposit receipt prints "Acknowledgement — not an invoice".
- Cash down payments and cash refunds count in the drawer's `expectedCash` and are listed apart in the session report ("Job order down payments"); they are not sales and not in Z-reading totals.
- **The sale at claim**: `POST /v1/job-orders/:id/claim` (Idempotency-Key, `clientTransactionId`, `sales.create` + `laundry.manage`, open drawer, tenders for the balance) → `SalesService.createFromJobOrder` → the private `record()` path, in one transaction: the sale's lines are the job's frozen lines (plus a storage fee line, §9); the deposit balance is applied first as a tender `{ method: 'JOB_DEPOSIT', jobOrderId }` (the sale's posting debits *Customer down payments* for it instead of cash) with an `APPLIED` deposit entry; the other tenders pay the rest. If the deposit is larger than the total (lines reduced after drop-off), the excess is refunded in cash in the same transaction (`REFUNDED`, drawer). `sales.job_order_id` (unique) links them; the job becomes CLAIMED with `sale_id`. Packages (§10) are redeemed and recipes consumed (§11) inside `record()` as for any sale.
- `JOB_DEPOSIT` is never sent by a client and never accepted on `POST /v1/sales` or offline (validation refuses it); only `createFromJobOrder` builds it.
- Returns of a claim sale follow ADR-0011 (cash or store credit; the job stays CLAIMED). A void of a claim sale is refused (`CLAIM_SALE_NOT_VOIDABLE`): a mistake is a return.

### 6. Ready notices and reminders (email now, SMS port)
- When a job becomes READY, `emitEvent('job_order.ready')` in the same transaction (ids only). The transaction queues a `job_order_notices` row and a `job_order.notice` event; the worker settles the row once (trigger: a queued row is settled once, never changed after) ( job, kind `READY` / `REMINDER` / `FINAL`, channel `EMAIL` / `SMS`, recipient masked, status `SENT` / `FAILED` / `SKIPPED`, provider reference) and sends:
  - **email** through the existing mailer when the customer (or the job) has an email;
  - **SMS** through a new `SmsSender` port (`@1pos/notifications` or the workers' adapters) when there is a phone number and the business has SMS on (`laundry_settings.sms_enabled`). Until a provider is chosen the only adapter is `DevSmsSender` (logs a masked number and the message length, stores nothing): **D7 — SMS provider and account** is added to the decisions. `SMS_PROVIDER` unset = Dev; the worker refuses to start in production with the Dev SMS driver, as for the dev mailer.
- Message (EN; FIL copy with the guide): "<Business>: your laundry J-000123 is ready for pickup at <branch>. Balance ₱<amount>. Open until <closing>." No item details, no claim code (the stub is the proof).
- **Reminders**: the worker's hourly pass calls `platform_flag_laundry_notices()` (SECURITY DEFINER, `onepos_worker`): a READY job not claimed after each of `laundry_settings.reminder_days` (default `{3,7}`) gets one `REMINDER`, and `unclaimed_days − final_notice_days` (default 30 − 3) one `FINAL` notice with the disposal date, each once (unique per job, kind, step). These are service messages, not marketing: they do not depend on marketing consent; the job's `notify` flag (default on) stops them.
- The till and admin show a **"Copy message"** button with the same text, for shops that text from their own phone.

### 7. Washers and dryers
- `laundry_machines` (branch, kind WASHER/DRYER, label unique per branch, capacity kg, default cycle minutes, `out_of_order` with reason, archived). Setup with `laundry.setup`.
- `machine_runs` (machine, `started_at`, `planned_minutes`, `ended_at` (stopped early) , source `SELF_SERVICE` (sale line) or `JOB` (job order), who). **No overlap**: GiST exclusion on (tenant, machine, `tstzrange(started_at, coalesce(ended_at, started_at + planned_minutes))`) → 409 `MACHINE_BUSY`. Append-only except `ended_at`, set once (trigger).
- **Self-service**: a counter sale line of a cycle variant may name `machineId` (same branch, same kind, not out of order). `record()` writes the run in the same transaction, starting at the end of the machine's current run if one is still going (a dryer "+10 min" queues behind itself), else at the sale time. Without `machineId` the cycle is sold as an ordinary item. Offline sales never carry a machine (the board is online).
- **Drop-off loads**: `POST /v1/job-orders/:id/machine-runs { machineId, minutes }` while the job is RECEIVED/WASHING/DRYING; it moves the job to WASHING or DRYING if it is behind.
- The **machine board** (`GET /v1/laundry/machines/board?branchId`): each machine with its current run (source, job number or sale, time left), next free time, out-of-order. `POST /v1/machine-runs/:id/stop` ends a run early. Amendment 2026-10-21: the board lists each machine's `queued` runs; stopping a run that has not started calls it off (`stopped_at = started_at`, an empty range, so no DDL; audited `machine_run.cancelled`). Voiding or returning a cycle sale ends its unfinished run in the return's transaction (`endReturnedCycleRuns`, called by `ReturnsService.record`): in full, a queued run is called off and a running one stops now; in part, the run is cut to the cycles kept.

### 8. Pickup and delivery
- `job_order_trips` (job, kind PICKUP/DELIVERY, address and contact phone (snapshot, personal data), `window_start`/`window_end`, rider (a member or a name), status `SCHEDULED` → `DONE` / `FAILED` (reason) / `CANCELLED`, notes, done at/by). A PICKUP trip may exist before the job has lines (`RECEIVED` with no lines; it is priced when weighed at the shop).
- Starting a DELIVERY trip (`POST /v1/laundry/trips/:id/start`) moves a READY job to OUT_FOR_DELIVERY; a delivery trip is marked DONE only by the claim at the door; a FAILED one moves it back to READY. The delivery fee is the branch's delivery item (`laundry_settings.delivery_variant_id`) added as a line when delivery is requested.
- **Paying on delivery**: the claim (§5) is recorded when the rider hands over: by the rider at the door on the till (their own drawer, as a mobile cashier) or at the counter when they return with the cash (`releasedVia: 'DELIVERY'`, the trip is marked DONE in the same transaction). The claim code check is replaced by the trip (the rider confirms the name).
- Permission `laundry.deliver` (trip list, mark done/failed); role **Rider** (`laundry.read`, `laundry.deliver`, `sales.create`, `cash.session`).
- `GET /v1/laundry/trips?branchId&date&status`: the day's route list, printable.

### 9. Unclaimed items
- `laundry_settings`: `unclaimed_days` (default 30, after READY), `final_notice_days` (3), `storage_free_days` (null = no storage fee), `storage_fee_variant_id` (a SERVICE item, per day), `claim_policy_text` (printed on the stub; a default EN/FIL text is offered, which the business must check with its own adviser: the rules on abandoned goods are **unverified**).
- **Storage fee**: at claim, a READY job older than `storage_free_days` gets one line of the storage item with quantity = days beyond (computed with the DB clock, branch calendar).
- **Unclaimed**: READY (or back from a failed delivery) for `unclaimed_days`: listed under "Unclaimed" (board filter, report). `POST /v1/job-orders/:id/dispose { reason: DONATED | DISCARDED | OTHER, note }` with `laundry.dispose` (owner, admin, branch manager), only after `unclaimed_days` and a FINAL notice that was **SENT** (decision A4, 2026-10-21), or with `customerUnreachable: true` and an `unreachableReason` (audited with the final notice's status; 409 `FINAL_NOTICE_PENDING` / `FINAL_NOTICE_NOT_SENT` otherwise): status DISPOSED, the deposit balance FORFEITED (§5). No sale is recorded; the job's lines stay as the record of what was not paid.
- **Cancel**: before CLAIMED, `POST /v1/job-orders/:id/cancel { reason, deposit: 'refund' | 'forfeit' }` (`laundry.manage`; forfeiting needs `laundry.dispose`). A job already processed that the customer pays for is claimed, not cancelled.

### 10. Prepaid laundry packages (extra)
- The salon packages (ADR-0022 §6) open to LAUNDRY through `usesPackages`: "10 loads wash-dry-fold", sold to a customer at the counter, owed on *2310 Prepaid service packages*. A job line may name `customerPackageId` for a `LOAD` or `PIECE` service (whole quantities only; `KG` services are not package items: 409 `PACKAGE_NEEDS_WHOLE_UNITS`). It is priced at zero on the job; the session is **redeemed at claim** inside `record()` (`planPackages`/`recordPackages`), so a package used up meanwhile refuses the claim (409 `PACKAGE_EXHAUSTED`) and the counter changes the line. Disposal and cancel redeem nothing.

### 11. Supplies used per load (extra)
- Recipes (ADR-0014 §4) for LAUNDRY services and self-service cycles: detergent and conditioner per load or per kilo (the recipe's quantities are per unit of the variant). Consumption is a `CONSUMPTION` movement **of the sale** (at claim for a job, at sale time for a cycle). A disposed or cancelled job posts none (LEFTOVER: supplies used on unclaimed jobs).
- Reorder points and the `stock.low` mail give the low-supply alerts.

### 12. Permissions and roles
- New codes: `laundry.read` (board, jobs, machines, trips), `laundry.manage` (receive, edit, status, machine runs, trips, cancel with refund, down payments), `laundry.release_override`, `laundry.deliver`, `laundry.dispose`, `laundry.setup` (machines, settings, garment types). Owner/admin all; branch manager all; cashier and senior cashier `laundry.read`, `laundry.manage`; accountant `laundry.read`.
- Role templates (LAUNDRY and HYBRID): **Laundry Attendant** (cashier + `laundry.read`, `laundry.manage`) and **Rider** (§8). Migration grants the codes to existing built-in roles and adds the templates to existing HYBRID businesses; a business that changes to LAUNDRY gets them then.

### 13. Reports
- **Job orders** (`/v1/reports/job-orders`): received, ready, claimed, cancelled, disposed per day and branch; average turnaround (received → ready), on-time % against `promised_at`, overdue now; kilos and loads by service.
- **Machine usage** (`/v1/reports/machine-usage`): per machine and day: cycles and minutes (self-service vs drop-off), utilisation over the branch's open hours, self-service cycle sales.
- **Down payments and unclaimed** (`/v1/reports/job-order-deposits`): open jobs with deposits beside GL 2330, unclaimed jobs and their value, forfeits.
- **Deliveries**: trips per day, done/failed, delivery fees.
- Machine utilisation is over the whole period (24-hour days): branches have no opening hours yet.
- Claim sales are ordinary sales in every sales, tax and Z report. All under `reports.read`, every plan; CSV in the admin.

### 14. Integrations
- Webhook topics (ids only): `job_order.ready`, `job_order.claimed`. API-key scope `laundry` → `laundry.read` (`GET /v1/job-orders`, `/v1/job-orders/:id`).

## Consequences
- New tables: `laundry_settings`, `laundry_garment_types`, `laundry_machines`, `machine_runs`, `job_orders`, `job_order_lines`, `job_order_items`, `job_order_status_changes`, `job_order_deposits`, `job_order_notices`, `job_order_trips`. New columns: `product_variants.laundry_unit`, `laundry_min_quantity`, `laundry_kg_per_load`, `laundry_addon`, `machine_kind`, `machine_minutes`; `sales.job_order_id`; `sale_tenders.job_order_id` (+ method `JOB_DEPOSIT`); `sale_lines.machine_id`. System accounts `CUSTOMER_DOWN_PAYMENTS` 2330, `FORFEITED_DOWN_PAYMENTS` 4120. Business type LAUNDRY; permissions §12; outbox topics `job_order.ready`, `job_order.notice`; webhook topics §14.
- A third checkout entry point, `SalesService.createFromJobOrder`, beside `create` and `createFromBill`; it records only through `record()`.
- Every new tenant table follows the tenant rules (composite FKs, ENABLE + FORCE RLS, grants for `onepos_app` and `onepos_worker`, fixtures in `isolation.test.ts`, `rls-catalog.test.ts`, export). `job_order_status_changes`, `job_order_deposits`, `job_order_notices` are append-only; `machine_runs` append-only except `ended_at` once.
- Personal data: job walk-in name and phone, trip address and phone, notice recipients (masked): rows in `processing-register.md` and `retention-schedule.md`; `PERSONAL_KEYS` gains the new field names; anonymising a customer blanks them on their jobs and trips.
- `ledger.test.ts`: GL 2330 = Σ job order deposits.

## Not covered (LEFTOVER)
- A real SMS provider (D7), notices in Filipino by customer preference, two-way SMS.
- Driving coin/card machine controllers; a customer-facing status page or app.
- Partial claims (some bags now, the rest later) and splitting a job.
- Supplies used on cancelled or disposed jobs; per-kilo packages.
- Customer accounts receivable (pay later, monthly billing for hotels and restaurants as laundry clients).
- The VAT timing of down payments and forfeits: accountant. The rules on abandoned goods and the claim policy text: the business's adviser.
