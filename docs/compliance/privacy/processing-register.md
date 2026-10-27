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
| People | Everyone with a Tilvara account: owners, managers, cashiers, accountants, Tilvara support staff |
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
| Tables | `tenant_memberships`, `membership_roles`, `member_invitations`; `tenant_extensions.changed_by` (the member who last switched an extension, ADR-0026); `tenant_branding.updated_by`, `brand_assets.created_by` (who last changed the branding or uploaded an image, session 39); `tenant_branding.contact_phone`, `contact_email`, `facebook`, `instagram`, `website` (the business's contact lines, which for a sole proprietor are their own: printed on receipts, shown on the customer display and the till, carried in the till snapshot and the data export) |

### 3. Sales and SC/PWD discount records — PIP
| | |
|---|---|
| Purpose | Record each sale for the business's books, tax filings and its SC/PWD sales book (RR 5-2017 requires name and ID number per discounted sale) |
| People | Senior citizens and persons with disability who receive the discount; the cashier who rang the sale |
| Data | Beneficiary **name, OSCA/PWD ID number, TIN if given**, discount scheme; never the disability type. Cashier's account id on each sale, shift, return, payment |
| Source | The cashier, from the customer's ID at the counter |
| Basis | For the business: legal obligation (Sec. 12(c)); if sensitive (README §2), processing provided for by law (Sec. 13(b)). Tilvara: processing on the business's instructions |
| Recipients | The business's authorised staff; its accountant through reports and exports; the BIR when the business files |
| Tables | `sale_beneficiaries` (append-only; the restaurant bill copies in `order_bill_beneficiaries` were deleted with the table, migration 0111); for 24 hours, copies of API answers in `idempotency_records`; while a cart is parked at a register, `held_carts.beneficiaries` (session 20: cleared the moment the cart is resumed or discarded) |
| Retention | Fiscal records: at least 5 years (schedule), then anonymised (job not built). A held cart's copy: until it is resumed or discarded (enforced by the database); a cart left open stays until someone discards it |
| Notes | Price changes at the counter (`price_overrides`, session 20) record which staff member asked and which approved, by account id, with the reason typed; the approver's email and password are checked once and never stored |

### 4. Restaurant orders — removed
Restaurants and counter service were removed on 2026-10-25 (migration 0111 dropped `restaurant_orders`, `kitchen_tickets` and `order_items`). Pickup names on earlier offline receipts stay only on the tills that printed them.

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
| Data | Legal entity name, trade name, TIN, registered address (personal data when the business is a sole proprietor), branch addresses, plan and subscription status; Tilvara's bills to the business and the payments for them (amount, method, the bank's or provider's reference, who recorded it), ADR-0027. **No card number or wallet login ever reaches Tilvara**: the provider's page collects them |
| Basis | Contract; legal obligation for receipts and tax |
| Recipients | The payment provider (PayMongo) for subscription payments: bill number, amount and ids only. The owners get bill and past-due mails (D2) |
| Tables | `legal_entities`, `branches`, `tenants`, `subscriptions`, `billing_bills`, `billing_payments`, `billing_checkouts`, `billing_receipts` (append-only or status-only changes; a receipt copies the business's registered name, TIN and address, personal data for a sole proprietor, and is mailed to the owners); `billing_provider_events` (event ids and outcomes, no personal data); `billing_seller` (Tilvara's own registration) |

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

### 15a. Salons: appointments, service notes, packages and service staff — removed
Salons were removed on 2026-10-25 (retail only; migration 0112 dropped `appointments`, `appointment_services`, `customer_notes`, `customer_packages`, `customer_package_items`, `customer_package_entries`, `service_staff`, `service_staff_services`, `service_staff_hours`, `service_staff_time_off`, `sale_tip_shares` and `sale_lines.service_staff_id`). **The data in them was deleted by the migration**: clients' appointments and guest names, service notes (including any health information), packages and their sessions, and service staff names, hours, time off and commission rates. Appointment reminders stopped. Nothing of it is collected any more. Old tips already recorded on sales stay with the sales (they name no staff member).

### 15b. Hotels and resorts — removed
Lodging was removed on 2026-10-25 (migration 0111 dropped stays, the guest registry, SC/PWD guests and folios); nothing of it is processed any more.

### 15d. Pharmacy: prescriptions, dispensing, pharmacist licences — removed
Pharmacies were removed on 2026-10-25 (retail only; migration 0112 dropped `prescriptions`, `prescription_items`, `prescription_fills`, `dispense_approvals`, `pharmacist_licenses` and `pharmacy_settings`, and the medicine label on sale lines). **The data in them was deleted by the migration**: patients' names and addresses, the medicines prescribed and dispensed to them, prescribers' names and licence numbers, yellow form numbers, and pharmacists' licence numbers. Nothing of it is collected any more. Lot codes, lot holds and the batch trace stay for every shop; they hold no personal data (the trace lists sales by number and the customer only if one was named on the sale).

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
