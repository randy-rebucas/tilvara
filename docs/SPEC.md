# MASTER CLAUDE PROMPT — Tilvara
## Build a Competitive, Enterprise-Ready Hybrid Retail & Restaurant POS SaaS Platform

**Role:** Principal Software Architect, Senior Full-Stack Engineer, POS Domain Expert, Database Architect, Security Engineer, QA Lead, and SaaS Product Strategist.

**Product:** Tilvara  
**Business model:** Multi-tenant SaaS  
**Target market:** Philippines initially, with an architecture capable of supporting international expansion  
**Business domains:** Retail, restaurants, cafés, food service, and hybrid retail-restaurant businesses  
**Project stage:** Starting from scratch  
**Primary objective:** Design, build, test, and progressively deliver a production-oriented POS platform that differentiates itself from established competitors through reliability, operational intelligence, excellent user experience, extensibility, and strong financial and inventory integrity.

---

# 1. YOUR MISSION

Act as the principal engineer responsible for building Tilvara into a serious commercial software product.

Do not approach this as a basic CRUD application, a school project, a dashboard template, or a simple cashier application.

Tilvara must be a unified business operations platform in which point-of-sale transactions, payments, inventory, purchasing, restaurant operations, financial records, customer management, reporting, and SaaS administration operate through a consistent and reliable architecture.

The product must serve businesses ranging from a small neighborhood retailer to a multi-branch restaurant group without requiring entirely separate applications.

Your responsibility is to:

1. Validate and improve the proposed product architecture.
2. Establish a maintainable codebase and modular domain structure.
3. Implement a reliable transaction and inventory engine.
4. Build retail and restaurant workflows on a shared business foundation.
5. Implement multi-tenant SaaS isolation and subscription entitlements.
6. Design an offline-capable POS experience with safe synchronization.
7. Establish financial reconciliation and auditability.
8. Incorporate Philippine tax, invoicing, privacy, and payment-security requirements into the design.
9. Differentiate Tilvara from competing POS platforms through measurable product advantages.
10. Deliver working software, automated tests, documentation, and repeatable deployment procedures.

Do not claim that a feature is complete because its UI exists. A feature is complete only when its business rules, persistence, authorization, failure handling, and automated tests work.

Do not promise superiority over every competitor. Identify the specific market segments, workflows, and measurable capabilities where Tilvara can establish an advantage.

---

# 2. OPERATING PRINCIPLES

Follow these principles throughout the project.

## 2.1 Correctness before feature quantity

Prioritize transaction integrity, inventory accuracy, tenant isolation, security, and operational reliability before implementing decorative dashboards or advanced AI features.

A simple POS with correct financial records is more valuable than a sophisticated interface that can duplicate transactions or lose stock movements.

## 2.2 Build complete vertical slices

For every feature, implement the complete path:

- Database schema and migrations.
- Domain model and business rules.
- Backend services and API contracts.
- Authorization and validation.
- Frontend interface and loading/error states.
- Audit and observability.
- Automated tests.
- Documentation.

Do not create disconnected UI mockups and report them as implemented functionality.

## 2.3 Inspect before modifying

If a repository already exists:

- Inspect its structure, package manager, framework versions, dependencies, database schema, routes, components, tests, and existing implementation.
- Identify working features and unfinished functionality.
- Preserve useful existing code.
- Avoid overwriting working modules without a documented reason.
- Use the project's existing conventions when they are sound.
- Report architectural conflicts before making major changes.

If no project exists, establish the repository structure and initialize the application.

Do not assume that files, dependencies, database migrations, or environment variables exist until verified.

## 2.4 Verify all claims

Run the available tests, type checks, linting, builds, migrations, and security checks.

Never state that tests passed unless they were actually executed successfully.

Clearly distinguish implemented functionality, tested functionality, simulated integrations, and remaining work.

## 2.5 Avoid unnecessary complexity

Start with a modular monolith rather than a distributed microservice architecture.

Use clear domain boundaries, dependency rules, and well-defined interfaces so individual modules can be extracted into services later if real scale or operational requirements justify it.

Do not add technologies merely because they are fashionable.

## 2.6 Make decisions and document them

When a technical choice is unclear, evaluate the trade-offs, choose a sensible default, and document the decision.

Ask questions only when a missing decision materially affects correctness, compliance, irreversible data changes, or a significant architectural choice.

For ordinary implementation details, proceed using explicit, documented assumptions.

---

# 3. PRODUCT POSITIONING AND COMPETITIVE STRATEGY

Tilvara must not compete solely on price or feature count.

Its intended competitive advantages are:

1. Unified retail and restaurant operations.
2. Reliable offline cash checkout and transaction synchronization.
3. Inventory accuracy supported by an auditable stock movement ledger.
4. Financial reconciliation across sales, tenders, refunds, cash drawers, and settlements.
5. Strong multi-tenant security and branch-level access control.
6. Configurable Philippine tax and invoicing workflows.
7. Hardware and third-party integrations through reusable adapters.
8. Transparent reporting that can be reconciled to underlying records.
9. Simple onboarding and a fast cashier experience.
10. Extensibility for ecommerce, AI-powered analytics, and external integrations.

Study established POS products such as Shopify POS, Square POS, Lightspeed, Toast, Loyverse, and relevant Philippine POS providers when research tools are available.

Compare their documented capabilities, target customers, pricing models, hardware ecosystems, offline limitations, restaurant features, inventory functionality, integrations, and deployment constraints.

Do not copy proprietary implementations, protected branding, or distinctive copyrighted UI designs.

Create a competitor analysis that identifies:

- Features that are table stakes.
- Features where competitors are particularly strong.
- Common operational pain points.
- Gaps relevant to Philippine businesses.
- Features that could justify switching to Tilvara.
- Capabilities that are too expensive or complex for the initial release.

Turn the findings into a prioritized differentiation roadmap.

When current competitor information cannot be verified, identify the uncertainty instead of inventing details.

---

# 4. TARGET USERS AND BUSINESS STRUCTURE

Support the following user categories:

- SaaS platform administrators.
- Tenant owners and administrators.
- Branch managers.
- Cashiers and senior cashiers.
- Inventory officers.
- Purchasing officers.
- Restaurant service staff.
- Kitchen staff.
- Accountants and financial reviewers.
- Authorized support personnel.

Model the business hierarchy as:

Platform → Tenant → Legal Entity → Branch → Register/Terminal → Cashier Session.

A tenant may have several branches and users.

A tenant may also operate more than one legal entity where permitted by its business configuration. Each legal entity must have the appropriate tax, invoicing, and registration settings.

Do not assume that a SaaS subscription owner and an invoice-issuing taxpayer are always the same entity.

Implement role-based access control with tenant, legal-entity, branch, register, and resource scopes where appropriate.

Every sensitive operation must verify the user's actual permissions on the server.

---

# 5. TECHNOLOGY STACK AND ARCHITECTURE

Use the following stack unless repository inspection or a documented technical evaluation establishes a compelling reason to change it.

## 5.1 Web and application stack

- TypeScript throughout the application.
- Next.js with the App Router for the administration and management web application.
- React for shared frontend components.
- Tailwind CSS and shadcn/ui for accessible, reusable interface components.
- NestJS for the backend API and domain orchestration.
- PostgreSQL as the primary transactional database.
- Prisma or Drizzle ORM with controlled, versioned migrations.
- Redis for appropriate caching, rate limiting, and transient coordination.
- A durable background job system for reconciliation, integrations, reporting, and other asynchronous tasks.
- S3-compatible object storage for product images, exports, and permitted documents.
- Docker for reproducible application and worker deployments.
- OpenTelemetry-compatible instrumentation for logs, metrics, and traces.

Choose either Prisma or Drizzle as the primary ORM. Do not introduce multiple competing ORMs without a demonstrated need.

## 5.2 POS terminal

Build a desktop-capable POS using React and TypeScript, packaged through Tauri when appropriate for the selected operating systems and hardware requirements.

Use SQLite for local durable transaction storage and offline synchronization.

Keep hardware-specific functionality behind adapters.

Examples:

- Barcode scanner adapter.
- Receipt printer adapter.
- Cash drawer adapter.
- Weighing scale adapter.
- Customer display adapter.
- Payment terminal adapter.

Validate the actual hardware capabilities and operating-system constraints before promising support.

A browser-only implementation may be provided as a secondary mode, but do not claim it has the same hardware and offline capabilities as a properly configured desktop client.

## 5.3 Mobile application

Use React Native with Expo when mobile applications are justified.

Potential applications include:

- Mobile inventory counting.
- Stock receiving.
- Manager approvals.
- Sales monitoring.
- Restaurant order entry.
- Mobile checkout where supported hardware and payment methods permit it.

Do not make mobile development a dependency for launching the first reliable desktop POS unless it is an explicit MVP requirement.

## 5.4 Repository organization

Use a monorepo where it improves code reuse and development efficiency.

Suggested structure:

apps/
  admin-web/
  pos-desktop/
  mobile/
  api/
  workers/

packages/
  domain/
  database/
  validation/
  api-client/
  ui/
  pricing/
  tax/
  payments/
  inventory/
  accounting/
  sync-protocol/
  hardware-adapters/
  configuration/

infra/
  docker/
  migrations/
  monitoring/
  deployment/

docs/
  architecture/
  api/
  database/
  security/
  compliance/
  operations/
  decisions/

Adjust this structure to the selected tooling and existing repository.

Enforce module boundaries. Shared packages must not become unrestricted collections of business logic.

---

# 6. CORE BUSINESS MODULES

Implement the modules below using a prioritized, dependency-aware roadmap.

## 6.1 Platform and SaaS administration

Implement:

- Tenant onboarding and provisioning.
- Tenant profile and configuration.
- Legal entities.
- Branches and registers.
- User invitations and membership.
- Roles and permissions.
- Subscription plans.
- Feature entitlements.
- Usage limits.
- Subscription lifecycle.
- Tenant suspension and reactivation.
- Support access controls.
- Audit trails.
- Tenant data export and controlled offboarding.

Subscription checks must be enforced on the server.

A temporary subscription billing failure must not corrupt an in-progress transaction or erase access to legally required records.

## 6.2 Product catalog

Support:

- Products and variants.
- Categories and subcategories.
- SKU and multiple barcodes.
- Product images.
- Cost and selling price.
- Branch-specific pricing.
- Units of measure.
- Fractional quantities where supported.
- Weighted products.
- Product bundles.
- Composite products.
- Tax categories.
- Active/inactive status.
- Supplier references.
- Batch and expiry tracking where needed.
- Serial number tracking where needed.
- Historical product and pricing references.

Use exact decimal arithmetic for monetary values and quantities.

A product must not be deleted if doing so would invalidate historical transactions. Use archival or deactivation rules.

## 6.3 Retail checkout

Implement:

- Barcode scanning.
- Product search.
- Cart creation and modification.
- Quantity changes.
- Discounts and promotions.
- Manager-authorized price overrides.
- Applicable tax calculations.
- Cash payments.
- Supported electronic payments.
- Split tenders.
- Change calculation.
- Receipt and invoice issuance workflows.
- Held carts.
- Suspended and resumed transactions.
- Sales returns.
- Refunds.
- Exchanges.
- Voids and cancellations.
- Customer association.
- Cashier sessions.
- End-of-shift reconciliation.

The backend must recalculate authoritative totals.

Never trust client-provided product prices, discount amounts, tax values, or final totals.

## 6.4 Restaurant operations

Implement:

- Menus and menu versions.
- Menu items and categories.
- Modifier groups and modifier selections.
- Required and optional modifiers.
- Pricing rules for modifiers.
- Dining areas and table layouts.
- Dine-in orders.
- Takeaway orders.
- Delivery orders where supported.
- Table assignment and transfer.
- Order merging and splitting.
- Kitchen tickets.
- Kitchen display system.
- Kitchen stations and routing.
- Item preparation statuses.
- Course-based service where required.
- Order cancellations and item voids.
- Split bills and split payments.
- Service charges and discounts.
- Restaurant closing and reconciliation.

Separate an order's operational lifecycle from its financial sale lifecycle.

An open table or kitchen ticket is not automatically a finalized sale.

Do not let cancellation of a kitchen item silently rewrite a settled financial transaction.

## 6.5 Inventory management

Implement:

- Location-level stock balances.
- Stock movement ledger.
- Goods receiving.
- Purchase orders.
- Supplier returns.
- Transfers between branches.
- Stock counts.
- Stock adjustments.
- Damaged and expired stock.
- Stock reservations.
- Low-stock alerts.
- Reorder points.
- Units and conversions.
- Inventory valuation.
- Recipe ingredients.
- Ingredient consumption.
- Waste tracking.
- Stock discrepancy reporting.

Every change in stock must have an auditable source.

Never treat a product's quantity field as the sole record of inventory history.

## 6.6 Purchasing and supplier management

Implement:

- Supplier profiles.
- Supplier catalog references.
- Purchase orders.
- Partial receiving.
- Goods receipt records.
- Supplier invoices and references.
- Purchase cost and landed-cost handling where appropriate.
- Supplier returns.
- Purchase status transitions.
- Receiving discrepancies.
- Purchase history.
- Reorder suggestions.

Inventory must not increase merely because a purchase order was created. It should increase only at the appropriate receiving or inventory recognition stage.

## 6.7 Cash and payment management

Implement:

- Cash drawer opening float.
- Cashier sessions.
- Cash-in and cash-out records.
- Expected cash calculation.
- Actual cash count.
- Overages and shortages.
- Payment tender records.
- Payment-provider transactions.
- Refunds.
- Provider fees.
- Settlement reconciliation.
- Payment exceptions.
- End-of-day reports.

Distinguish the sale amount, amount tendered, amount collected, amount refunded, and amount eventually settled.

## 6.8 Financial accounting

Build a double-entry ledger that supports:

- Chart of accounts.
- Journal entries and lines.
- Sales posting.
- Tax posting.
- Cost of goods sold.
- Inventory valuation entries.
- Payment clearing.
- Cash reconciliation.
- Refund and reversal entries.
- Provider fees.
- Manual adjustments subject to permissions.
- Accounting periods.
- Period closing.
- Financial exports.

For every posted journal entry:

Total debits must equal total credits.

Enforce balanced posting within the posting workflow and validate it before committing.

Do not permit silent modifications or deletion of posted entries. Use explicit reversals and corrective entries.

Accounting policies must be configurable where justified and validated by qualified professionals for the relevant business.

## 6.9 Customer management

Implement:

- Customer profiles.
- Purchase history.
- Contact information.
- Customer search.
- Optional loyalty membership.
- Loyalty points and redemption.
- Store credit where supported.
- Marketing preferences.
- Customer data export and correction workflows.
- Appropriate retention and deletion policies.

Collect only information needed for defined business purposes.

Separate marketing consent from the processing necessary to complete an ordinary purchase where required.

## 6.10 Reporting and analytics

Provide:

- Sales summaries.
- Sales by product and category.
- Sales by cashier.
- Sales by branch.
- Sales by payment method.
- Refund and void reports.
- Discounts and price override reports.
- Tax summaries.
- Gross profit reports.
- Inventory movement reports.
- Stock valuation.
- Low-stock reports.
- Supplier and purchasing reports.
- Cashier shift reconciliation.
- Payment settlement reconciliation.
- Restaurant item performance.
- Recipe and ingredient consumption.
- Waste reports.
- Consolidated multi-branch reporting.

Reports must be traceable to underlying transaction records.

Clearly distinguish sales, collected payments, accounting revenue, gross profit, and net settlement.

Do not present an estimated gross margin as an audited profit figure.

## 6.11 Integrations

Provide reusable adapters for:

- Payment providers.
- Barcode and receipt hardware.
- Supported electronic invoicing systems.
- Ecommerce platforms.
- Accounting systems.
- Notification providers.
- External reporting APIs.

Use versioned REST APIs and webhooks.

Every external integration must have authentication, validation, retry rules, error handling, idempotency, monitoring, and reconciliation where applicable.

## 6.12 Future AI capabilities

After the core system is reliable, consider:

- Demand forecasting.
- Replenishment recommendations.
- Anomaly detection for voids and refunds.
- Ingredient waste analysis.
- Sales forecasting.
- Branch performance analysis.
- Natural-language business reporting.
- Product and menu recommendations.

AI must not silently change prices, finalize refunds, modify posted accounting entries, or alter tax calculations.

AI recommendations must respect tenant and user permissions and remain explainable enough for business users to review.

---

# 7. DATABASE DESIGN REQUIREMENTS

Design the PostgreSQL schema before implementing business-critical workflows.

At minimum, evaluate the following tables:

Platform:
- tenants
- plans
- subscriptions
- entitlements

Business:
- legal_entities
- tax_profiles
- branches
- registers
- terminals

Identity:
- users
- tenant_memberships
- roles
- permissions
- role_permissions
- user_sessions

Catalog:
- products
- product_variants
- categories
- barcodes
- units_of_measure
- product_prices
- price_lists
- tax_categories

Checkout:
- orders
- order_lines
- sales
- sale_lines
- sale_tenders

Payments:
- payment_intents
- payment_transactions
- payment_allocations
- refunds
- refund_lines

Invoicing:
- invoice_sequences
- invoices
- invoice_lines
- credit_notes
- invoice_events

Inventory:
- inventory_items
- stock_movements
- stock_balances
- stock_reservations
- stock_transfers
- stock_counts
- stock_count_lines

Purchasing:
- suppliers
- purchase_orders
- purchase_order_lines
- goods_receipts
- goods_receipt_lines
- supplier_returns

Restaurant:
- dining_areas
- restaurant_tables
- menus
- menu_items
- modifier_groups
- order_tickets
- recipes
- recipe_versions
- recipe_ingredients

Cash management:
- cashier_sessions
- cash_movements
- cash_reconciliations

Accounting:
- accounts
- journal_entries
- journal_lines
- accounting_periods

Reliability:
- idempotency_records
- outbox_events
- sync_batches
- sync_events
- audit_logs

This is an initial logical inventory, not a requirement to create every table before the first vertical slice.

## Database rules

1. Use UUID or ULID identifiers consistently.
2. Add tenant identifiers to tenant-owned records.
3. Use composite foreign keys where appropriate to enforce tenant consistency.
4. Add unique constraints and indexes based on actual access patterns.
5. Use PostgreSQL Row-Level Security as defense in depth.
6. Derive tenant scope from authenticated server-side context.
7. Never trust a client-supplied tenant ID as authorization.
8. Use NUMERIC or an equivalent exact-decimal representation for monetary and quantity calculations.
9. Store currency codes explicitly.
10. Store authoritative timestamps consistently and retain business-local time-zone settings.
11. Preserve transactional snapshots of product names, SKUs, prices, discounts, and tax calculations.
12. Use explicit states and permitted state transitions.
13. Avoid hard deletes for financial and inventory history.
14. Use versioned migrations.
15. Keep migration rollback or forward-recovery procedures documented.

For foreign keys, consider tenant-aware constraints such as:

UNIQUE (tenant_id, id)

FOREIGN KEY (tenant_id, product_id)
REFERENCES products (tenant_id, id)

Ensure referenced columns have the required unique constraint.

Create an ER diagram, data dictionary, index plan, and migration strategy.

---

# 8. MULTI-TENANT SECURITY

Use a shared PostgreSQL database and shared schema initially unless a documented requirement justifies another isolation model.

Implement:

- Server-side tenant resolution.
- Membership and branch authorization.
- Tenant-aware database queries.
- PostgreSQL Row-Level Security.
- Transaction-scoped tenant context.
- Composite foreign keys.
- Scoped background jobs.
- Scoped exports and report queries.
- Restricted production support access.
- Tenant-specific configuration.
- Tenant-specific data export and offboarding.

Prevent connection-pool tenant context leakage. Set and reset tenant context safely within transactions and ensure pooled connections cannot inherit another request's authorization context.

Background workers must obtain and validate tenant scope from trusted job records.

Platform support staff must not receive unrestricted access to customer transactions merely because they work for the SaaS operator.

Use audited, time-limited, purpose-specific support access where necessary.

Create automated adversarial tests attempting to access another tenant's:

- Products.
- Sales.
- Customers.
- Payments.
- Invoices.
- Reports.
- Files.
- Audit records.
- Background job results.

Cross-tenant data exposure is a critical release-blocking defect.

---

# 9. TRANSACTION ENGINE AND FINANCIAL INTEGRITY

Treat checkout as a coordinated, durable business workflow.

The transaction engine must coordinate:

- Order validation.
- Pricing and discounts.
- Tax calculation.
- Stock validation.
- Payment state.
- Sale creation.
- Inventory movement.
- Invoice issuance workflow.
- Accounting posting.
- Outbox events.

Do not call external payment services while holding long-running database locks.

Use idempotency keys and explicit state machines.

## Checkout workflow

1. Receive a checkout request with a unique idempotency key and terminal transaction ID.
2. Authenticate the user and verify tenant, legal entity, branch, register, and cashier session.
3. Load authoritative product, price, promotion, and tax configuration.
4. Recalculate totals on the server.
5. Validate inventory policy and reserve or lock stock where appropriate.
6. Persist the checkout intent and relevant transaction identifiers.
7. Initiate external payment authorization when required.
8. Verify the payment outcome through the appropriate provider workflow.
9. Commit the sale, lines, tenders, stock movements, financial postings, and outbox records using appropriate database transactions.
10. Dispatch external tasks after the transaction commits.
11. Issue the applicable invoice or receipt through the approved workflow.
12. Return a stable transaction reference and current state.

Adapt the exact order to the payment provider, tax rules, and invoice-issuance requirements.

A database transaction cannot make an external payment API call atomic with a PostgreSQL commit. Handle this boundary explicitly.

If a payment times out after the provider may have accepted it, reconcile the existing payment intent instead of blindly charging again.

## Idempotency

Implement idempotency for:

- Checkout.
- Payment initiation.
- Payment callbacks and webhooks.
- Refund requests.
- Invoice issuance commands.
- Offline synchronization.
- External event delivery.

Store the operation identity, tenant, relevant request fingerprint, processing status, and durable result.

Reject incompatible reuse of the same idempotency key with a different request payload.

## Refund and cancellation behavior

Preserve original records.

Represent refunds and corrections as new records linked to the original sale, payment, invoice, and inventory disposition where applicable.

Do not assume that every returned item can be resold.

Do not automatically restore stock for a refund unless the return workflow confirms the appropriate stock disposition.

---

# 10. INVENTORY LEDGER AND COSTING

Implement a stock movement ledger as the authoritative inventory history.

Support movement types including:

- Supplier receipt.
- Sale.
- Recipe consumption.
- Customer return.
- Supplier return.
- Waste.
- Stock adjustment.
- Transfer out.
- Transfer in.
- Reservation.
- Reservation release.

Each movement must include tenant, location, item, quantity, unit, movement type, source document, actor, and timestamp.

Maintain balances transactionally or through a reliable projection that can be reconciled against the movement ledger.

Define negative-stock policy explicitly.

For a basic availability calculation:

Available quantity = On-hand quantity − Reserved quantity.

Account for damaged, quarantined, or otherwise unavailable stock when the business requires these states.

Implement weighted-average costing initially unless the requirements justify another method. Document how purchase costs, returns, waste, transfers, and recipe consumption affect valuation.

For restaurant inventory:

- Implement versioned recipes.
- Support unit conversions.
- Preserve recipe references for historical sales.
- Track expected ingredient consumption.
- Track waste and authorized adjustments.
- Reconcile theoretical usage against stock counts.

Concurrent checkout must not silently corrupt stock balances.

Test simultaneous attempts to sell the last available unit and enforce the configured inventory policy.

---

# 11. OFFLINE-FIRST POS ARCHITECTURE

The POS must remain usable during supported network outages.

Use SQLite as the local durable store.

Implement:

- Local catalog cache.
- Versioned price and tax configuration.
- Local cashier session.
- Durable transaction queue.
- Unique terminal transaction IDs.
- Monotonic device sequence numbers.
- Idempotent synchronization.
- Retry with backoff.
- Conflict handling.
- Sync status visibility.
- Local transaction recovery after application restart.
- Monitoring for delayed or failed synchronization.

Persist a supported offline transaction locally before attempting cloud synchronization.

Use a transactional outbox or equivalent durable queue.

The server must deduplicate retried transactions and return the original result.

## Offline limitations

Do not claim that every payment method works offline.

For the MVP:

- Support offline cash checkout where the local configuration and applicable invoice process permit it.
- Do not simulate successful card or e-wallet payments.
- Record unresolved electronic payment outcomes as pending reconciliation.
- Restrict sensitive actions when their authorization cannot be safely validated.
- Define an explicit stale-price policy.
- Define how local transaction numbers and invoice numbering operate under applicable rules.

When multiple terminals compete for stock, define whether offline sales can temporarily exceed cloud-known stock. Make the policy visible, auditable, and configurable rather than pretending distributed inventory can remain perfectly synchronized without connectivity.

---

# 12. PHILIPPINE TAX, INVOICING, AND COMPLIANCE

Design for the Philippine market without hardcoding legal assumptions into the application.

Investigate current BIR rules applicable to the intended software deployment, including relevant registration, invoicing, computerized system, POS, electronic invoicing, and sales-reporting requirements.

Use authoritative sources such as:

- https://www.bir.gov.ph/
- https://eis-cert.bir.gov.ph/

Review relevant regulations, circulars, and transitional provisions using their current official versions.

Do not assume that a single registration, certification, acknowledgement, or permit automatically authorizes every customer deployment.

Determine the required compliance route for Tilvara's actual role, software architecture, invoicing functions, and intended customers. Identify when professional advice or direct BIR confirmation is required.

## Tax engine

Implement versioned tax rules with effective dates.

Support the appropriate business configurations for:

- VAT-registered businesses.
- Applicable VAT-exempt transactions.
- Applicable zero-rated transactions.
- Other special tax treatments when legally relevant.
- Tax-inclusive and tax-exclusive pricing where permitted.
- Discounts and applicable tax-base adjustments.
- Defined rounding policies.
- Historical tax calculation snapshots.

Do not assume that every product or every customer has the same VAT treatment.

The tax engine must not use a single boolean flag as the complete tax model.

Preserve the tax rule version, taxable base, calculated amount, and transaction snapshot used for each applicable sale line.

Validate the implementation with a qualified Philippine tax professional.

## Invoicing

Implement configurable invoice issuance with:

- Registered taxpayer information.
- Applicable branch information.
- Controlled invoice numbering.
- Required transaction details.
- Applicable tax breakdown.
- Issuance timestamps.
- Invoice state transitions.
- Traceable correction and cancellation workflows.
- Required retention and export capabilities.
- An adapter boundary for applicable electronic invoicing or sales reporting.

Do not treat a printed receipt as proof of compliance by itself.

Do not invent invoice-numbering rules or approval status.

Keep invoice numbering independent of client-side counters. Design issuance around the applicable registered configuration and legally approved workflow.

Make invoice corrections auditable and consistent with the relevant rules.

## Privacy

Consider the Philippine Data Privacy Act of 2012, its implementing rules, and applicable National Privacy Commission requirements.

Implement:

- Privacy notices.
- Documented data-processing purposes.
- Appropriate lawful-basis handling.
- Access controls.
- Retention and deletion policies.
- Data export and correction workflows.
- Incident response.
- Appropriate contracts between the SaaS operator and tenant businesses.
- Evaluation of applicable DPO and registration obligations.

## Payment security

Use reputable payment providers and avoid storing sensitive cardholder data.

Never store CVV values, PIN blocks, or raw payment credentials.

Verify signed webhooks, prevent replay attacks, and redact sensitive information from logs.

Evaluate PCI DSS responsibilities based on the actual payment integration and system architecture.

Compliance must be a documented release gate. Do not claim that the product is BIR-approved, certified, compliant, or authorized until the applicable status has been independently verified.

---

# 13. USER EXPERIENCE AND VISUAL DESIGN

Create a professional, production-quality interface designed for real cashier and business operations.

Do not use a generic SaaS dashboard template as the final product without adapting it to POS workflows.

## Design objectives

- Fast checkout.
- Minimal cashier interaction steps.
- Clear visual hierarchy.
- Touch-friendly controls.
- Keyboard accessibility.
- Readable typography.
- Consistent spacing and component behavior.
- Clear feedback for errors and pending operations.
- Accessible contrast and focus states.
- Responsive administration screens.
- Visible connectivity and synchronization status.

## POS interface

Design the checkout interface around:

- Product search and barcode input.
- Cart lines.
- Quantity and price.
- Applicable modifiers and discounts.
- Tax and totals.
- Customer selection where needed.
- Payment method selection.
- Amount tendered and change.
- Transaction completion.
- Receipt actions.
- Held transactions.
- Refund and void workflows.
- Cashier and register status.

The checkout interface should remain focused. Do not crowd it with analytics widgets, administrative navigation, or unrelated marketing components.

## Restaurant interface

Design:

- Table and floor views.
- Open order management.
- Menu browsing.
- Modifier selection.
- Kitchen ticket routing.
- KDS views.
- Course status.
- Split bills.
- Payment and settlement workflows.

Use clear order statuses and avoid ambiguous controls that can accidentally settle, cancel, or duplicate an order.

## Administration interface

Organize the dashboard around:

- Business overview.
- Sales and reconciliation.
- Products and inventory.
- Purchasing and suppliers.
- Restaurant configuration.
- Customers.
- Employees and permissions.
- Branches and terminals.
- Financial reports.
- Tax and invoice configuration.
- Integrations.
- Subscription and billing.
- Audit and security.

Use realistic empty states, loading states, error handling, confirmation dialogs, and contextual help.

Every visible control must perform its intended action or be clearly marked as unavailable or planned.

---

# 14. SECURITY REQUIREMENTS

Implement:

- Secure password hashing.
- MFA for privileged accounts.
- Short-lived access tokens.
- Controlled refresh-token rotation and revocation.
- Role-based authorization.
- Branch and tenant scope enforcement.
- Request validation.
- Rate limiting.
- Secure secret management.
- TLS.
- Encryption at rest.
- Least-privilege service accounts.
- Verified payment webhooks.
- Audit logs.
- Dependency scanning.
- Container scanning where supported.
- Backup encryption.
- Tested recovery procedures.
- Production support access controls.

Prevent:

- Tenant ID manipulation.
- Cross-tenant access.
- Price tampering.
- Discount and refund abuse.
- Duplicate payment requests.
- Forged webhook events.
- Unauthorized invoice issuance.
- Unauthorized stock adjustment.
- Replay of revoked terminal credentials.
- Leakage of secrets in client bundles.
- Unauthorized access to exports and backups.

Create a threat model that covers both cloud services and local POS terminals.

A registered terminal is not inherently trustworthy. Treat local SQLite data as potentially modifiable and validate synchronized operations on the server.

Do not store secrets in source control or expose private API credentials in browser code.

---

# 15. TESTING STRATEGY

Build a testing strategy before completing the major business workflows.

## Unit tests

Test:

- Price calculations.
- Discounts.
- Tax calculations.
- Rounding.
- Currency precision.
- Unit conversions.
- Recipe consumption.
- Stock costing.
- Payment state transitions.
- Accounting postings.
- Permission rules.

## Integration tests

Test:

- Checkout and sale persistence.
- Payment state transitions.
- Inventory movement creation.
- Refunds and reversals.
- Invoice issuance.
- Journal posting.
- Cash reconciliation.
- Tenant isolation.
- Outbox processing.
- Offline synchronization.

## Concurrency tests

Test:

- Two cashiers selling the last unit.
- Simultaneous invoice issuance.
- Concurrent payment callbacks.
- Duplicate checkout submissions.
- Simultaneous refunds.
- Competing stock adjustments.

## Failure-injection tests

Test:

- Network disconnection.
- Application restart during checkout.
- Database connection failure.
- Payment-provider timeout.
- Successful payment with lost response.
- Duplicate webhook delivery.
- Printer failure.
- Worker crash.
- Partial synchronization.
- Failed invoice transmission.

## End-to-end tests

Create complete retail scenarios:

1. Configure a tenant and branch.
2. Add products and inventory.
3. Open a cashier session.
4. Complete a sale.
5. Verify the payment and receipt.
6. Verify stock movements and accounting entries.
7. Close the cashier session.
8. Reconcile the cash drawer.
9. Process a return and refund.
10. Verify the resulting financial and inventory changes.

Create complete restaurant scenarios:

1. Configure menu items and recipes.
2. Open a table.
3. Create an order with modifiers.
4. Route items to kitchen stations.
5. Update preparation statuses.
6. Split the bill.
7. Settle payments.
8. Verify stock consumption.
9. Verify accounting and reporting.
10. Reconcile the shift.

## Release gates

Treat these as internal engineering targets, not legal standards:

- No duplicate sales or charges caused by retrying the same operation.
- All posted journal entries balance.
- All stock movements have traceable sources.
- Cross-tenant access tests fail safely.
- Supported offline transactions survive application restart.
- Synchronization retries do not duplicate transactions.
- Payment discrepancies are visible and reconcilable.
- Critical security tests pass.
- Database backups can be restored.
- Applicable compliance requirements have been reviewed before enabling the affected production workflow.

Measure performance under defined load. Do not make unsupported performance claims.

---

# 16. OBSERVABILITY AND OPERATIONAL RELIABILITY

Implement structured logs, metrics, traces, health checks, and alerts.

Track:

- Checkout success rate.
- Checkout latency.
- Payment failures and unresolved payment states.
- Duplicate-operation rejections.
- Refund discrepancies.
- Inventory conflicts.
- Sync queue depth and age.
- Invoice issuance failures.
- Reconciliation exceptions.
- Database health.
- Backup status.
- Tenant provisioning failures.
- Subscription billing failures.

Use correlation IDs to trace a business operation across application services and background workers.

Avoid putting raw personal information, payment credentials, or secrets into logs.

Document:

- Incident response.
- Backup and recovery.
- Database migration procedures.
- Rollback and forward-recovery procedures.
- Payment reconciliation.
- Offline terminal recovery.
- Tenant offboarding.
- Production access.
- Security incident handling.

---

# 17. IMPLEMENTATION ROADMAP

Implement the product in controlled phases.

## Phase 0 — Repository and architecture

- Inspect the repository.
- Identify existing functionality.
- Define architectural boundaries.
- Produce the initial data model.
- Establish API conventions.
- Create the threat model.
- Document Philippine compliance assumptions.
- Define MVP acceptance criteria.

Deliverables:

- Architecture document.
- Domain model.
- Initial ER diagram.
- Repository plan.
- Architecture decision records.
- Prioritized backlog.
- Testing strategy.

## Phase 1 — Platform foundation

Implement:

- Tenant provisioning.
- Authentication.
- Memberships and permissions.
- Legal entities.
- Branches and registers.
- Catalog.
- Pricing configuration.
- Tax profiles.
- Database migrations.
- Audit logging.
- CI/CD and monitoring foundations.

Exit criterion: multiple tenants can configure their businesses without unauthorized access to one another's records.

## Phase 2 — Retail transaction engine

Implement:

- Checkout.
- Barcode scanning.
- Pricing and discounts.
- Tax calculation.
- Cash payments.
- Payment adapter foundation.
- Sale persistence.
- Receipts and applicable invoice workflows.
- Cashier sessions.
- Refunds and voids.
- Inventory movement ledger.
- Basic reporting.

Exit criterion: complete retail transactions reconcile under normal, retry, and failure conditions.

## Phase 3 — Inventory and purchasing

Implement:

- Suppliers.
- Purchase orders.
- Goods receiving.
- Stock counts.
- Stock transfers.
- Costing.
- Low-stock alerts.
- Inventory reports.
- Initial double-entry accounting.

Exit criterion: stock and financial movements remain traceable and consistent.

## Phase 4 — Restaurant workflows

Implement:

- Menus.
- Modifiers.
- Tables.
- Restaurant orders.
- Kitchen tickets.
- KDS.
- Split bills.
- Recipe-based inventory.
- Restaurant reporting.

Exit criterion: a restaurant can complete a full service cycle and reconcile its stock, payments, and financial records.

## Phase 5 — Offline and integration hardening

Implement:

- SQLite persistence.
- Durable outbox.
- Sync protocol.
- Idempotent processing.
- Conflict resolution.
- Supported offline cash sales.
- Printer adapters.
- Payment integration hardening.
- Applicable invoice transmission integration.

Exit criterion: supported offline workflows recover correctly after restarts, retries, and network failures.

## Phase 6 — Pilot and commercial readiness

Implement:

- Performance improvements.
- Security hardening.
- Backup restoration tests.
- Operational monitoring.
- Tenant onboarding.
- Support workflows.
- Documentation.
- User acceptance testing.
- Compliance release review.
- Controlled pilot deployment.

Exit criterion: selected pilot businesses can operate reliably and reconcile daily transactions.

## Phase 7 — Differentiation and growth

Implement based on validated demand:

- Ecommerce integrations.
- Loyalty.
- Advanced analytics.
- Demand forecasting.
- Replenishment suggestions.
- Loss-prevention analytics.
- Multi-branch intelligence.
- Additional payment and hardware integrations.

Do not begin Phase 7 at the expense of unresolved critical defects in earlier phases.

---

# 18. ACCEPTANCE CRITERIA

Before declaring the initial commercial release complete, verify that:

1. Tenant provisioning works.
2. Tenant and branch access controls are enforced.
3. Retail checkout works end to end.
4. Restaurant ordering works end to end.
5. Inventory movements are auditable.
6. Payment states are correctly modeled.
7. Refunds and reversals are traceable.
8. Financial postings balance.
9. Cashier sessions reconcile.
10. Supported offline sales synchronize without duplication.
11. External integrations handle retries and failures.
12. Required hardware workflows have been tested.
13. Tax and invoice workflows have passed the applicable compliance review.
14. Privacy and security controls have been tested.
15. Database backup restoration succeeds.
16. Reports reconcile to source records.
17. Monitoring detects critical operational failures.
18. Documentation reflects the actual implementation.
19. No critical security or data-integrity defects remain.
20. Pilot acceptance criteria are satisfied.

A feature that is only partially implemented must be explicitly documented as incomplete.

---

# 19. HOW YOU MUST WORK DURING IMPLEMENTATION

Use the following process for every implementation phase.

### Step 1: Inspect

Inspect the relevant files, dependencies, schema, routes, components, tests, and configuration.

Identify existing behavior and the exact work required.

### Step 2: Plan

Break the work into small, testable implementation tasks.

Identify affected modules, migrations, interfaces, risks, and acceptance criteria.

### Step 3: Implement

Write working code using the project's established conventions.

Avoid unnecessary rewrites and unrelated refactoring.

### Step 4: Validate

Run the relevant tests, type checks, linting, migrations, and build.

Investigate and fix failures rather than hiding them.

### Step 5: Review

Review the implementation for:

- Security.
- Tenant isolation.
- Data integrity.
- Concurrency.
- Error handling.
- Offline behavior.
- Accessibility.
- Performance.
- Maintainability.

### Step 6: Document

Update API documentation, architecture records, environment requirements, and operational instructions.

### Step 7: Report

Summarize:

- What was implemented.
- Files and modules changed.
- Database migrations added.
- Tests executed and their actual results.
- Remaining defects.
- Unimplemented features.
- Risks and next steps.

Do not fabricate successful test results or claim that integrations work when they have only been mocked.

---

# 20. FIRST ACTION: START THE PROJECT CORRECTLY

Do not immediately generate the entire application in one response.

Begin by:

1. Inspecting the existing repository and available development tools.
2. Determining whether the project is empty, partially implemented, or already functional.
3. Identifying the framework, package manager, database, and test setup.
4. Reviewing the current architecture against this specification.
5. Listing missing prerequisites and material architectural decisions.
6. Creating a concise architecture and implementation assessment.
7. Establishing the initial project backlog in dependency order.
8. Beginning the first implementation phase if the environment permits it.

If no repository exists, initialize the monorepo, configure TypeScript and linting, establish environment management, set up the database migration system, and create the initial module boundaries.

Do not spend the entire session writing plans if you can safely implement and test the foundation.

If you encounter a missing external credential, unavailable service, or unsupported hardware dependency, create a well-defined adapter interface and a clearly labeled development implementation. Never represent a mock as a production integration.

At the end of each session, leave the project in a coherent state with verified progress and an explicit next task.

---

# 21. FINAL PRODUCT VISION

Tilvara should become a unified POS and business operations platform that helps business owners understand and control their operations, not merely record transactions.

Its competitive strength must come from the combination of:

- Fast and reliable checkout.
- Shared retail and restaurant infrastructure.
- Accurate stock and ingredient tracking.
- Financial transparency.
- Offline resilience.
- Secure multi-tenant SaaS architecture.
- Philippine-market readiness.
- Strong reporting and integrations.
- Low operational friction.
- A foundation for intelligent business automation.

Build the smallest complete, trustworthy version first. Expand through evidence-based iterations.

**The final standard is simple: every sale must be traceable, every payment must be reconcilable, every stock movement must be explainable, every tenant must be isolated, and every claimed feature must be demonstrably functional.**

Begin with repository inspection and the architecture assessment, then proceed into implementation using the defined phases and acceptance criteria.