# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary (admin web):** owners and managers of small-to-mid Philippine retail shops, cafés, restaurants and hybrid businesses, working mostly on a laptop or desktop to set up and review the business (confirmed 2026-10-15). Phone use of the admin is secondary.
- Other roles that use the admin with narrower permissions: branch managers, inventory/purchasing officers, accountants.
- Cashiers and kitchen staff work in the separate POS terminal app, not the admin web.

## Product Purpose

Tilvara is a multi-tenant POS and business-operations SaaS for the Philippines. The admin web is where a business is set up (legal entity, branches, registers/terminals), its team and permissions are managed, its catalog and prices are maintained, and later its sales, inventory, cash and financial records are reviewed and reconciled. Success: an owner configures the business without help and trusts that every figure shown reconciles to underlying records.

## Positioning

Unified retail + restaurant operations on one foundation, with financial and inventory integrity as the product's core claim: every sale traceable, every stock movement explainable, every tenant isolated, nothing deleted from history. Designed for Philippine operating reality (VAT / non-VAT entities, BIR branch codes, SC/PWD rules) without claiming BIR accreditation.

## Operating Context

- Owners set up the business once, then return for team changes, catalog/price updates, and (later phases) daily/period reviews.
- Business hierarchy the UI must reflect: Tenant → Legal entity (taxpayer, TIN, VAT status) → Branch (BIR branch code) → Register → Terminal.
- Access is role- and scope-based (tenant / legal entity / branch / register); users only see what their grants allow.
- Subscription states: trial, active, past-due grace, read-only. Read-only businesses still see all records.

## Capabilities and Constraints

- Built today (API): sign-up/onboarding with a 14-day Growth trial, sign-in with tenant selection, legal entities/branches/registers/terminals, team invitations and roles with anti-escalation, catalog (products, variants, barcodes, categories, units, tax categories), price lists with scheduled prices, subscription view.
- Money is always exact decimal text from the API (e.g. "49.7500"); display in PHP with centavos.
- Invoicing/BIR features are disabled until compliance review; the UI must not imply compliance or accreditation.
- Billing (PayMongo) is not integrated yet; plan prices are placeholders and must not be shown as real prices.
- **Languages: English and Filipino from the first release** (confirmed 2026-10-15). All UI copy goes through a message catalog; English is the default.

## Brand Commitments

Name: **Tilvara**. No logo, colors or fonts exist yet (confirmed 2026-10-15); the visual direction established in code is provisional and replaceable.

## Evidence on Hand

None: no customers, testimonials, case studies, screenshots or metrics exist. Do not fabricate any.

## Product Principles

1. Truth over polish: show real states (pending, read-only, limits reached, errors) plainly; never fake success.
2. Every control works or is visibly marked as planned.
3. The hierarchy is the map: the UI follows Tenant → Entity → Branch → Register so owners always know where a change applies.
4. Fast for the owner: few steps to set up, clear next action, nothing decorative in the way.
5. Bilingual by default: copy is short, plain, and translatable.

## Accessibility & Inclusion

WCAG 2.2 AA target. Keyboard-complete flows, visible focus, sufficient contrast, readable on mid-range laptops. Copy available in English and Filipino.
