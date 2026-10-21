# Record of processing activities (draft)

> **DRAFT, NOT LEGAL ADVICE.** Lawful bases are engineering's reading for the DPO to confirm. Facts about
> the system were checked against the schema and code on 2026-10-18 (migrations 0000–0055).

Controller: **[Tilvara operator legal name, address]**. DPO: **[name, email]**.
Hosting: **[provider, region]** (decision D1; until then development machines only, no production data).

Roles: **PIC** = Tilvara is controller; **PIP** = Tilvara processes for the business, which is controller
(see README §1). Retention details and enforcement status: [retention-schedule.md](retention-schedule.md).

Safeguards that apply to every activity, so they are not repeated in each row:
- every business's records are isolated by row-level security forced in the database, with the business
  taken from the signed-in session only; a test suite attacks every route across businesses;
- encryption in transit (TLS at the edge, HSTS); encryption at rest of the database and storage comes with
  the hosting choice (D1);
- role-based permissions per business and branch; two-step sign-in required for owners, admins and
  accountants;
- every change to business records is written to an append-only audit log;
- encrypted backups (age, public-key encryption at the source);
- logs never contain request bodies, query strings, tokens or passwords.

## Register

### 1. Accounts and sign-in — PIC
| | |
|---|---|
| Purpose | Let people sign in to Tilvara securely; protect accounts from takeover |
| People | Everyone with a Tilvara account: owners, managers, cashiers, kitchen staff, accountants, Tilvara support staff |
| Data | Email, display name, password hash (argon2id), failed sign-in count and lock time, last sign-in time; sessions (refresh-token hash, start/expiry/revocation, **browser user agent**); two-step sign-in secret (encrypted AES-256-GCM, key outside the database) and hashed recovery codes; hashed password-reset tokens (30 minutes); a requested new sign-in email with its hashed confirmation link (24 hours); `closed_at`, when the person closed the account |
| Source | The person (sign-up, invitation acceptance, Your account page); their browser (user agent) |
| Basis | Contract (Sec. 12(b)): needed to provide the account. Security measures: legitimate interest (Sec. 12(f)) |
| Recipients | No one outside Tilvara. Email provider for reset and invitation mail (D2) |
| Tables | `users`, `user_sessions`, `user_mfa_factors`, `user_mfa_recovery_codes`, `password_reset_tokens`, `email_change_tokens` (platform tables; the API reaches the credential tables only through audited database functions) |
| Retention | Account: while it exists; the person can close it (blocked at once, second factor and pending links removed; anonymisation not built). Sessions, reset and email-change tokens: **no purge yet** (proposed in the schedule) |
| Notes | IP addresses are used in memory for rate limits and never stored by the application |

### 2. Business membership, roles and invitations — PIC (membership) / PIP (the business's team records)
| | |
|---|---|
| Purpose | Decide who may do what in each business |
| People | Members and invitees |
| Data | Membership status, roles and branch scopes; invitation email, who invited, hashed invitation token |
| Source | The business's owner or admin |
| Basis | Contract (Sec. 12(b)) |
| Recipients | Owners and admins of that business; the business's data export (`members.csv`: email, name) |
| Tables | `tenant_memberships`, `membership_roles`, `member_invitations` |

### 3. Sales and SC/PWD discount records — PIP
| | |
|---|---|
| Purpose | Record each sale for the business's books, tax filings and its SC/PWD sales book (RR 5-2017 requires name and ID number per discounted sale) |
| People | Senior citizens and persons with disability who receive the discount; the cashier who rang the sale |
| Data | Beneficiary **name, OSCA/PWD ID number, TIN if given**, discount scheme; never the disability type. Cashier's account id on each sale, shift, return, payment |
| Source | The cashier, from the customer's ID at the counter |
| Basis | For the business: legal obligation (Sec. 12(c)); if sensitive (README §2), processing provided for by law (Sec. 13(b)). Tilvara: processing on the business's instructions |
| Recipients | The business's authorised staff; its accountant through reports and exports; the BIR when the business files |
| Tables | `sale_beneficiaries`, `order_bill_beneficiaries` (append-only); for 24 hours, copies of API answers in `idempotency_records`; while a cart is parked at a register, `held_carts.beneficiaries` (session 20: cleared the moment the cart is resumed or discarded) |
| Retention | Fiscal records: at least 5 years (schedule), then anonymised (job not built). A held cart's copy: until it is resumed or discarded (enforced by the database); a cart left open stays until someone discards it |
| Notes | Price changes at the counter (`price_overrides`, session 20) record which staff member asked and which approved, by account id, with the reason typed; the approver's email and password are checked once and never stored |

### 4. Restaurant orders — PIP
| | |
|---|---|
| Purpose | Call out takeaway and counter-service orders (session 25: the pickup name of a counter sale, printed on the receipt and kitchen ticket); run tables and the kitchen |
| People | Customers who give a name for a takeaway or a counter order; staff who open, fire, void and close orders |
| Data | `customer_name` (free text, optional), order notes; staff ids on orders, tickets and voids |
| Source | Cashier or waiter |
| Basis | For the business: contract with the customer (Sec. 12(b)) |
| Tables | `restaurant_orders`, `kitchen_tickets`, `order_items` |
| Notes | Staff should be told not to type phone numbers or other details into names and notes |

### 5. Suppliers and purchasing — PIP
| | |
|---|---|
| Purpose | Order from and pay suppliers; returns to suppliers |
| People | Suppliers who are natural persons (sole traders) and the contact details the business enters |
| Data | Supplier name, TIN, email, phone, address, notes |
| Basis | For the business: contract (Sec. 12(b)), legal obligation for tax records (Sec. 12(c)) |
| Tables | `suppliers` (never deleted, archived) and purchasing documents |

### 6. Staff activity on records — PIP
| | |
|---|---|
| Purpose | Accountability: who sold, counted, approved, voided, adjusted, posted |
| People | Members of the business |
| Data | Account id on every document (`*_by` columns), reasons and notes they enter (e.g. a variance note) |
| Basis | For the business: legal obligation (books and audit trail) and legitimate interest (internal control) |
| Retention | With the documents they sit on |

### 7. Audit log and security monitoring — PIC (account events) / PIP (business events)
| | |
|---|---|
| Purpose | Prove who did what; detect and investigate misuse |
| People | Everyone with an account; Tilvara support staff |
| Data | Actor, action, resource, time, correlation id, details (e.g. a reset reason, an item name). Account events outside a business (lockouts, refresh-token reuse, MFA changes, resets, staff and support openings) are kept at platform level |
| Basis | Legitimate interest (Sec. 12(f)); for the business, legal obligation where the audit trail is part of its records |
| Recipients | The business sees its own log (permission `audit.read`); platform rows are read by Tilvara ops only |
| Tables | `audit_logs` (append-only, cannot be truncated) |
| Notes | Application logs carry account and business ids and route templates, never bodies; their retention depends on the host (D1). Metrics carry no personal data by design (fixed label sets) |

### 8. Support access — PIP, inside the business's grant
| | |
|---|---|
| Purpose | Let Tilvara help a business that asks for it |
| People | The granting owner/admin; Tilvara staff; anyone whose data appears on the pages support reads |
| Data | Grant (purpose, ticket, who gave it, duration ≤ 72 h); every page support read, in the business's audit log |
| Basis | The business's instruction (its grant). Staff accounts: contract and legitimate interest |
| Tables | `support_grants`, `platform_staff`, `audit_logs` |
| Notes | Read-only; every write refused; the business sees and can end it at any time |

### 9. Data export for the business — PIP
| | |
|---|---|
| Purpose | Give the business a copy of all its records (portability; leaving Tilvara) |
| Data | Every table of the business's records, members' emails and names; no credential hashes |
| Recipients | The owner/admin who downloads it (10-minute links) |
| Tables | `data_exports`; files in private storage (`DevFileStorage` until D1) |
| Retention | File deleted after 7 days; the request row stays as evidence |

### 10. Backups — PIC (accounts) / PIP (business records)
| | |
|---|---|
| Purpose | Recover from loss or corruption |
| Data | A full copy of the database: everything above |
| Recipients | Ops only; the secret key is held by two people and never on the database or backup store |
| Retention | 30 days locally (newest three always kept); off-site retention with D1 |

### 11. Offline tills — PIP
| | |
|---|---|
| Purpose | Keep selling cash when the internet is down |
| Data | On the till PC: the price snapshot, the register's open shift (cashier's account id), every sale rung offline on that till and its delivery state. Offline sales are cash only and carry no SC/PWD details (the discount needs the server) |
| Location | `%APPDATA%\ph.onepos.till\till.sqlite` on the business's PC; terminal credential in Windows Credential Manager |
| Retention | **No local purge yet**: synced sales stay on the PC (README §3) |

### 12. Transactional email — PIC
| | |
|---|---|
| Purpose | Invitations, password reset, welcome mail, sign-in email change (a link to the new address, a notice to the old one), stock alerts to members who keep stock at a branch (low stock, sold below zero; item and branch names only) |
| Data | Recipient email, name, a one-time link. Logs keep only the template and a masked recipient (`m***@example.ph`) |
| Recipients | The email provider (D2); `DevMailer` (no delivery) until then |

### 13. Card and QR payments — PIP
| | |
|---|---|
| Purpose | Take non-cash payments |
| Data | Amount, method, outcome, provider reference. **No card number or CVV ever reaches Tilvara**; the provider's terminal or page collects them |
| Recipients | The payment provider (PayMongo, D6; not live yet) |
| Tables | `payment_intents`, `payment_events` (append-only) |

### 14. Business registration and subscription — PIC (contact) / business data
| | |
|---|---|
| Purpose | Set up and bill the business |
| Data | Legal entity name, trade name, TIN, registered address (personal data when the business is a sole proprietor), branch addresses, plan and subscription status |
| Basis | Contract; legal obligation for receipts and tax |
| Tables | `legal_entities`, `branches`, `tenants`, `subscriptions` |

### 15. Customers, their consent and store credit — PIP (session 20, ADR-0018)
| | |
|---|---|
| Purpose | Know who bought what (receipts, returns, after-sales), keep a customer's store credit, and send offers only to customers who agreed |
| People | The business's customers who give their name |
| Data | Name (required); optional customer number, phone, email, TIN (business buyers), address, notes; marketing consent yes/no with its history (when, how: at the counter, in the back office, at the customer's request, who recorded it); the customer on each sale; store credit entries |
| Source | The customer, through the cashier or a manager |
| Basis | For the business: contract (Sec. 12(b)) for the purchase and store credit; **consent** (Sec. 12(a)) for offers, asked separately and withdrawable at any time (a withdrawal is recorded at once by anyone who can open the customer) |
| Recipients | The business's staff who hold `customers.read`/`customers.manage`; purchase history only to those who may read those sales; the business's data export |
| Tables | `customers`, `customer_consent_events` (append-only), `customer_credit_entries` (append-only), `sales.customer_id` |
| Rights | Access: "Download their data" (JSON of profile, consent history, purchases, credit; audited). Correction: "Correct details" (audited by field name, not value). Erasure: "Remove personal details" blanks every personal field for good (refused while store credit is owed); sales stay for the fiscal period without the name |
| Retention | *Proposed:* anonymise a customer 2 years after their last purchase, unless store credit is owed (DPO to confirm). Today: kept until the business anonymises them |
| Notes | Notes must never hold health, beliefs or ID numbers (the form says so). The audit log names changed fields, never their values |

### 15a. Salons: appointments, service notes, packages and service staff — PIP (session 27, ADR-0022)
| | |
|---|---|
| Purpose | Book clients with a staff member, remind them the day before, keep what a stylist or therapist needs to serve them safely (colour formulas, preferences, allergies), keep the sessions of prepaid packages, and credit staff with their services, commissions and tips |
| People | The business's clients (customers, or walk-ins booked by name); the business's service staff (who may or may not sign in) |
| Data | Appointments: the client (customer, or a guest name), branch, time, services, staff, status, notes, cancellation reason, whether to remind and when a reminder was sent. **Service notes** (free text, may contain health information such as allergies: sensitive personal information, DPA Sec. 3(l)). Packages bought and the sessions used. Service staff: name, optional link to a member, branch, calendar colour, commission rate, working hours, time off (with an optional reason); the staff member named on each sale line, their commission rate at the sale, their share of each tip |
| Source | The client, through the front desk; the business's managers (staff records) |
| Basis | Clients: contract (Sec. 12(b)) for the booking, the package and the service; service notes on health: **consent** or the need to provide the service safely (Sec. 13(f) medical treatment does not apply; the business should ask the client before writing an allergy down — the form says to keep only what the service needs). Reminders are service messages about the client's own booking, not marketing; they stop when the front desk unticks "remind". Staff: the employment or service contract (Sec. 12(b)) and the business's legitimate interest in paying commissions (Sec. 12(f)) |
| Recipients | The business's staff with `appointments.read` (calendar), `customers.read` (notes, visits, packages); **service notes are never shown to an API key or to a Tilvara support session**, whatever their `customers.read` grant (refused with 403 `SERVICE_NOTES_RESTRICTED`; audit decision A1, 2026-10-21); an API key with the `appointments.read` scope reads the calendar, appointments and service staff (appointment notes are blanked for API keys and support sessions too); commission rates only to `staff.manage`; the email provider for reminders (ids only in the event; the mail carries the branch, time, services and staff first names) |
| Tables | `appointments`, `appointment_services`, `customer_notes`, `customer_packages`, `customer_package_items`, `customer_package_entries` (append-only), `service_staff`, `service_staff_services`, `service_staff_hours`, `service_staff_time_off`, `sale_lines.service_staff_id`, `sale_tip_shares` (append-only) |
| Rights | Access: the customer export includes appointments, service notes and packages. Correction: notes are edited in place (audited by id, never the text). Erasure: "Remove personal details" deletes the service notes and clears appointment notes; it is refused while package sessions are owed. A guest name on an appointment is erased with the appointment's retention (below) |
| Retention | *Proposed:* appointments (with guest names and notes) 2 years after the appointment; service notes with the customer (anonymised 2 years after the last purchase); staff records while the person works there plus the fiscal period of the last sale naming them (DPO to confirm) |
| Notes | The note form tells staff to keep only what the service needs. Audit rows never carry note text or guest names; `guestName` is redacted from logs |

### 15b. Hotels and resorts: stays, the guest registry, SC/PWD guests and folios — PIP (session 28, ADR-0023)
| | |
|---|---|
| Purpose | Book rooms, check guests in and out, keep the guest registry and registration card the front desk records at check-in, apply the SC/PWD discount to the beneficiaries' share of each room night, and keep each stay's folio (room nights, charges from outlets, deposits, payments) |
| People | The business's guests (customers, or guests booked by name) and everyone recorded in a stay's registry; SC/PWD guests |
| Data | Stays: guest (customer or a guest name), room, dates, adults, children, agreed rate, charge limit, source and external booking reference, notes, cancellation reason. **Guest registry**: full name, nationality, ID type and number, address, optional birth date and contact. SC/PWD guests: scheme, name, ID number, share of the room. Folios: entries, payments (method, bank reference), deposits |
| Source | The guest, at booking and at check-in through the front desk; an external PMS or channel only by the front desk keying it in |
| Basis | Contract (Sec. 12(b)) for the stay; the registry and registration card as the establishment's legal obligation where the LGU or tourism rules require one (Sec. 12(c); **DPO to confirm per place**); SC/PWD details by legal obligation (RA 9994, RA 10754, Sec. 12(c)) |
| Recipients | Staff with `lodging.manage` (registry, registration card); `lodging.read` sees stays and guest names only (housekeeping, cashiers finding an in-house guest for Charge to room); an API key with the `lodging` scope reads stays, folios and rooms but never the registry; webhooks carry ids only |
| Tables | `stays`, `stay_guests`, `stay_beneficiaries`, `folios`, `folio_entries` (append-only), `folio_payments` (append-only), `stay_deposits` (append-only), `room_status_changes` (append-only, staff ids) |
| Rights | Access: the data export includes every table. Correction: registry rows are edited in place (audited by field name, never the value). Erasure: "Remove personal details" on the customer deletes the registry of their stays; SC/PWD names stay with the books (as `sale_beneficiaries`) |
| Retention | *Proposed:* registry 1 year after check-out (or as the LGU rule requires, DPO to confirm), then deleted; stays and folios for the fiscal period (they post to the books); SC/PWD guests the fiscal period |
| Notes | Audit rows name changed fields only; `fullName`, `idNumber`, `nationality`, `idType`, `birthDate`, `address`, `contact`, `guestName` are redacted from logs (`PERSONAL_KEYS`) |

### 15c. Laundry: job orders, pickups and deliveries, notices — PIP (session 29, ADR-0024)
| | |
|---|---|
| Purpose | Take in laundry against a claim ticket, tell the customer when it is ready (email, and SMS once a provider is chosen), pick it up from and deliver it to the customer, and release it to the right person |
| People | The laundry's customers, walk-ins named on a job, and whoever a rider meets at a pickup or delivery address |
| Data | Job orders: customer or a walk-in name and phone, weight, items counted, condition notes, special instructions, status history, down payments. Trips: address, contact phone and name, time window, rider name. Notices: kind, what each channel did, and the recipient **masked** (`l***@example.ph`, `***4567`) |
| Source | The customer at the counter or by phone; the rider at the door |
| Basis | Contract (Sec. 12(b)): the laundry service, its notices (service messages, not marketing: they do not depend on marketing consent; the job's "notify" switch stops them) and its delivery |
| Recipients | Staff with `laundry.read` / `laundry.manage`; riders (`laundry.deliver`) see the trips of their branch with address and phone; the email provider (D2) and the SMS provider (D7) receive the recipient and the message text only (no items, no claim code); an API key with the `laundry` scope reads job orders; webhooks carry ids only |
| Tables | `job_orders`, `job_order_lines`, `job_order_items`, `job_order_trips`, `job_order_notices` (settled once), `job_order_status_changes` (append-only, staff ids), `job_order_deposits` (append-only) |
| Rights | Access: the data export includes every table. Correction: a job's name, phone and notes and a trip's address are edited in place (audited by field name only). Erasure: "Remove personal details" on the customer blanks the walk-in name and phone of their jobs and the address, phone and name of their trips |
| Retention | *Proposed:* trips' address and phone 90 days after the trip, walk-in name and phone 1 year after the claim (DPO to confirm); job orders and down payments for the fiscal period (claims post to the books) |
| Notes | `customerName`, `customerPhone`, `contactPhone`, `contactName`, `address` are redacted from logs (`PERSONAL_KEYS`); the dev SMS sender logs a masked number and the message length only |

### 15d. Pharmacy: prescriptions, dispensing, pharmacist licences — PIP (session 30, ADR-0025)
| | |
|---|---|
| Purpose | Dispense prescription medicines and dangerous drugs only against a prescription, keep the pharmacy's prescription book and dangerous drugs register, and let a licensed pharmacist approve at the till |
| People | Patients (the pharmacy's customers or someone they buy for), prescribing physicians, dentists and veterinarians, the business's pharmacists |
| Data | **Health data (sensitive personal information, Sec. 3(l))**: the medicines prescribed and dispensed to a named patient, with directions. Prescriptions: patient name and (for dangerous drugs) address, prescriber name, PRC licence and S2 numbers, yellow form number, date issued, notes. Fills: what was dispensed from which item, when, by whom. Pharmacist licences: a member's PRC licence number and validity |
| Source | The prescription the patient presents at the counter; the business's owner/admin for licences |
| Basis | Legal obligation (Sec. 13(b)/(c): pharmacy, generics and dangerous drugs laws require the records; **DPO and pharmacist-in-charge to confirm** the specific provisions); contract for the sale itself |
| Recipients | Staff with `pharmacy.read` / `pharmacy.dispense` (pharmacists, assistants, branch managers); not accountants (`reports.read` does not open the books); not Tilvara support sessions (`pharmacy.read` is not a support permission); never API keys or webhooks |
| Tables | `prescriptions`, `prescription_items` (replaced as a set until the first fill), `prescription_fills` (append-only), `dispense_approvals` (staff ids only), `pharmacist_licenses` |
| Rights | Access: the data export includes every table. Correction: a prescription is edited in place until something is dispensed on it (audited by field name only, never the value), then it no longer changes. Erasure: "Remove personal details" on the customer unlinks their prescriptions; the patient's details stay as the dispensing record until the retention period ends (**DPO to confirm**, see the retention schedule) |
| Retention | *Proposed:* prescriptions and fills for at least the fiscal period, or the period the pharmacy rules require (to confirm), then anonymised; licences while the member is a member |
| Notes | Audit rows name the prescription by id only; `patientName`, `patientAddress`, `prescriberName`, `prescriberLicenseNo`, `prescriberS2No`, `yellowFormNo`, `licenseNo` and `prescriptions` are redacted from logs (`PERSONAL_KEYS`); receipts print the generic name and lot, never the patient |

### 16. Integrations: API keys and webhooks — PIP (session 20, ADR-0019)
| | |
|---|---|
| Purpose | Let a business connect its own systems (bookkeeping, e-commerce, dashboards): a read-only key, and messages to an address it chooses when a sale or stock event happens |
| People | The member who made a key or webhook (named on the key); indirectly, customers and staff whose records a key may read within its scopes |
| Data | Key name, prefix, scopes, who made it, when made, expires, last used, revoked and by whom; the key's SHA-256 hash (never readable by the app). Webhook address, description, topics, on/off, a signing salt (the secret is derived, never stored). Deliveries: topic, the event's ids (sale, branch, register, variant), tries, last HTTP status or error, times |
| Source | The business's owner/admin (`integrations.manage`); the outbox (events) |
| Basis | For the business: contract with its own processors; for Tilvara: processor on the business's instruction (Sec. 12(b)) |
| Recipients | The system holding the key (reads within the scopes); the webhook address's operator (ids only, no names, contacts or amounts tendered) |
| Tables | `api_keys`, `webhook_endpoints`, `webhook_deliveries` |
| Rights | A key or webhook is not personal data of a customer; a key's reads are the business's own access to its records (the business answers access requests under §15 and §5) |
| Retention | Keys and endpoints: until the business is deleted (revoked keys are kept as evidence). *Proposed:* purge delivered/dead `webhook_deliveries` after 30 days (not built yet; DPO to confirm) |
| Notes | The business must have its own agreement with whoever receives the data (the screen says a key reads the records it is given). Audit rows name a key by prefix and a webhook by host only |
