# Tilvara — Philippine Compliance Assumptions

> **NOT LEGAL OR TAX ADVICE.** This is an engineering research summary compiled on **2026-10-15** from public sources, many of them secondary (law/accounting firm commentary, vendor help pages). Every rule below must be confirmed by a Philippine CPA/tax lawyer and, where noted, directly with the BIR before Tilvara is released to paying PH merchants.
>
> **Tilvara must not claim to be "BIR-accredited", "BIR-certified", "BIR-compliant" or "BIR-authorized" in any medium until accreditation is actually granted and verified.** The BIR issued a Public Advisory on **14 Sept 2026** stating it has not accredited, certified, or endorsed *any* e-invoicing service provider (ESP), and that no entity may represent itself as such (see §4.3). Marketing copy must say something like "designed to support BIR invoicing requirements; accreditation pending".

Confidence legend: **Verified** = read in primary/official text or an official-agency copy. **Partially verified** = consistent across multiple reputable secondary sources, primary text not read. **Unverified** = single/vendor source, conflicting sources, or inference.

Design principle used throughout: **every tax rate, threshold, discount rule, document label, and numbering rule is tenant/branch-configurable data with effective-dated versions — never a hardcoded constant.**

---

## 1. Ease of Paying Taxes Act (RA 11976) and RR 7-2024 — "Invoice" replaces "Official Receipt"

| Item | Detail |
|---|---|
| What it says | Invoices (not Official Receipts) are now the primary evidence of sale of **both goods and services**. ORs are no longer proof of sale; leftover ORs may be used only as *supplementary* documents stamped "This document is not valid for claim of input tax." VAT-registered sellers must issue a VAT invoice for **every** sale regardless of amount (RMC 77-2024). Non-VAT sellers must issue an invoice for single transactions **≥ / > ₱500** (sources differ on "more than" vs "₱500 or more"), on buyer request, or when the day's aggregated sub-₱500 sales exceed ₱500. The ₱500 threshold is CPI-adjusted every 3 years from 22 Jan 2024. Business style no longer required on invoices. |
| CRM/POS transition | Changing the printed title from "Official Receipt" to "… Invoice" on CRM/POS/e-receipting software is a **minor enhancement** (no re-accreditation), but taxpayers had to file an Annex D inventory (starting serial number + start date of converted invoice) within 30 days of reconfiguration or by 31 Dec 2024, whichever first. Converted ORs valid for input-VAT claims only until 31 Dec 2024. |
| Effective | RR 7-2024 effective **27 Apr 2024**; amended by RR 11-2024; clarified by RMC 77-2024 (11 Jul 2024). |
| Records retention | Books/records: **5 years** (EOPT amended Sec. 235) from the day after the filing deadline (or actual filing date if late). Extends while a protest/refund is pending. |
| Sources | Grant Thornton on RMC 77-2024; MTF Counsel (May 2025); KPMG; PwC EOPT alert (pwc.com/ph/en/tax/tax-alerts/2024/pwc-ph-ease-of-paying-taxes-2024.pdf) |
| Confidence | **Partially verified** (RR 7-2024 primary text not read). |
| Tilvara implication | Document types are configurable labels: `SALES_INVOICE` (principal), `SUPPLEMENTARY` (order slip, void slip, return/refund slip, acknowledgment, billing statement) — supplementary docs must print "THIS DOCUMENT IS NOT VALID FOR CLAIM OF INPUT TAX" in bold. Never print "Official Receipt" as a principal document. Non-VAT invoice threshold and the "aggregate at end of day" rule must be config, with a daily job that flags/issues an aggregate invoice if required. Data retention ≥ 5 years (we recommend 10 years configurable, since other laws/LGUs/malls may require longer — confirm). |

## 2. Required invoice contents (machine-generated invoice from a POS)

Primary source: **RMO 24-2023 digest (bir.gov.ph)** listing what accredited sales machines/software must print (it references RR 16-2018, RR 6-2022, RR 11-2004 Sec. 6), plus RR 7-2024 commentary. **Verified** for the RMO list (read the official BIR digest PDF); RR 7-2024 overlay **partially verified**.

**Header**
1. Registered name of seller
2. Business name/style, if any (EOPT says style no longer mandatory — keep optional)
3. Detailed business address
4. `VAT REG TIN` or `NON-VAT REG TIN` + 9-digit TIN + **5-digit branch code**
5. **Machine Identification Number (MIN)** (issued by BIR per registered terminal)
6. Serial number of the machine (branded) or HDD serial / software license number (cloned/software POS)

**Body**
7. Invoice number — **at least 6 digits**, running serial, **appended with Reset Counter** if applicable. If the system also generates a *transaction number*, the invoice number must be a **separate series**.
8. Date of transaction
9. Buyer name, address, TIN (and business style) — required for VAT invoices **when sale ≥ ₱1,000 to a VAT-registered buyer** (RR 7-2024, per MTF Counsel). Input VAT may be disallowed for the buyer if name/TIN missing.
10. Quantity, description, unit cost, total cost
11. VAT amount shown separately; total **inclusive** of VAT
12. Mixed transactions: breakdown into **VATable Sales, VAT-Exempt Sales, Zero-Rated Sales** (exempt/zero-rated sales labelled as such)
13. Non-VAT sellers selling only exempt goods: word **"EXEMPT"**; non-VAT with mixed SSPT/exempt: breakdown of Sales Subject to Percentage Tax and Exempt Sales
14. **SC / PWD / NAAC / Solo Parent sales:** customer TIN (if any), ID number (OSCA/PWD ID/PNSTM ID/Solo Parent ID), discount (5% or 20%) **with detailed breakdown including VAT exemption**, and customer signature (signature not required for online purchases per RR 8-2023 — partially verified)

**Footer**
15. Name, address, TIN + branch code of the **accredited supplier** of the sales machine/software
16. Supplier **Accreditation Number + date issued + valid until**
17. **PTU number + date issued** (or ATG control number for subscription e-invoicing)
18. The old "THIS INVOICE/RECEIPT SHALL BE VALID FOR FIVE (5) YEARS…" phrase was removed by RR 6-2022 / RMC 123-2022 (**unverified**, vendor source) — do not print it.

**If the POS cannot capture buyer details** for a VAT-registered buyer, the seller must issue a manual ATP invoice and attach the tape to the duplicate; those sales are then deducted from eSales reporting (RMO 24-2023).

**Tilvara implication:** Receipt templates are data-driven per branch/terminal with required-field validation that blocks going live if MIN, serial, PTU, accreditation fields are missing. Buyer-info capture is prompted automatically when `total >= buyer_info_threshold (config, default ₱1,000)` and the customer is flagged VAT-registered. Keep invoice # series and internal transaction/order # series separate.

## 3. Serial numbering, Z/X readings, eJournal, audit trail (sales-machine technical requirements)

Source: **RMO 24-2023** (issued 26 Jun 2023) — **Verified** for the list of features; exact field-level specs (the "Functional and Technical Evaluation Checklist") **not obtained — Unverified**.

Required features (must be attested in a notarized Sworn Statement and demonstrated to a BIR Technical Working Group):
a. **Accumulated Grand Total** sales (non-resettable; vendor sources say ≥10 digits/12 incl. decimals — unverified)
b. **Tamper-free**
c. **Activity / transaction log**
d. **Non-volatile memory**
e. **E-journal / audit journal** (copies of every invoice, void, refund, X and Z reading, chronological; vendors commonly export as .txt)
f. **Sales readings** (X-reading = intraday/shift, non-resetting; Z-reading = end-of-day close, increments Z-counter)
g. **Backend reports** (sales summary, VATable/exempt/zero-rated, discounts by type, voids, returns/refunds, SC/PWD/NAAC/SP sales books)
h. **Sequential series of accountable forms** (gapless; no manual override of numbers)
i. **Reprint functionality** (reprints must be marked as reprints — inferred)
j. **"Push" functionality**
k. **Verification / validation seal**
l. **Data retention**
m. **Sales data transmission** (eSales / EIS)

Z-reading typical contents (vendor/secondary, **partially verified**): Z-counter, reset counter, beginning & ending invoice numbers, previous and present accumulated grand total, gross sales, VATable/VAT-exempt/zero-rated sales, VAT amount, discounts by type (SC/PWD/NAAC/SP/other), voids, returns/refunds, net sales, payment-type breakdown. StoreHub notes Gross Sales includes voided transactions with voids/refunds/discounts subtracted to Net, and voids and refunds have their own numbered series.

Other rules:
- **Major enhancements** (new functionality, new reports, DB platform change, hardware change for bundled) → **new accreditation** required, with a comparison matrix. **Minor enhancements** (UI field arrangement, transparent security controls) → notify RDO only. **Verified (RMO 24-2023).** This is a major constraint on continuous deployment of a SaaS POS.
- Accreditation can be revoked for sales suppression, tampering of sales data, or misrepresentation in the sworn statement. **Verified.**
- eSales monthly reporting of CRM/POS sales (RR 16-2018 / RMO 12-2012 framework); amendments to reported eSales need written justification and adjusting entries (RMC 56-2015). **Partially verified.**

**Tilvara implication:**
- Invoice numbers allocated **per terminal (MIN)** from a gapless counter; offline terminals must hold their own counter locally — **never** a cloud-allocated sequence that breaks offline. No deletion of invoices; voids/returns are new documents in their own series referencing the original.
- Append-only, hash-chained event log (each record includes prev-hash) for the e-journal; grand total stored and verified against the chain.
- Z-reading is a terminal-level, idempotent, once-per-business-day operation; X-readings unlimited.
- Release engineering: a "BIR-frozen" fiscal core module, versioned separately from the rest of the app, so UI/back-office changes don't count as major enhancements. Any change to the fiscal core triggers a compliance review gate.

## 4. Registration: supplier accreditation, PTU, CAS ACK, ORUS

### 4.1 Software supplier (Tilvara as vendor)
- Under **RMO 24-2023**, POS software (bundled or software-only), CRMs, **e-invoicing/e-receipting systems used under subscription-based agreements**, and handheld/mobile devices linked to a server **must be accredited** via the **Enhanced eAccReg System**. Steps: enroll (sworn declaration to LT Office/RDO of the supplier's head office) → online application + manual documentary submission → system demo to TWG (scheduled within 3 working days of complete docs) → Certificate of Accreditation within 20 working days. Accreditation is **free**. Accreditation number is tied to a **brand/model/system/software version**. A "pseudo supplier" (taxpayer developing its own) also needs accreditation. **Verified (official digest).**
- Note the digest says subscription-based e-invoicing will use an **Authority to Generate (ATG)** under a separate issuance. Tilvara is a SaaS subscription — **which track applies (POS accreditation vs. subscription e-invoicing ATG vs. EIS certification) is a key open question.** **Unverified.**
- **RMC 72-2025 (14 Jul 2025)**: CRM/POS accreditation certificates expiring 31 Jul 2025 — suppliers must apply for new accreditation under RMO 24-2023; existing taxpayer PTUs do **not** lapse merely because the supplier certificate expired. **Partially verified** (PwC summary via search; page 403).
- A list of accredited sales machines/software is supposed to be posted on bir.gov.ph. Current list not located. **Unverified.**

### 4.2 Merchant (taxpayer-user)
- Each terminal is **registered** to get a **Permit to Use (PTU)** and **MIN** via eAccReg (RMO 24-2023 references PTU for sales machines; StoreHub's July 2026 guide says **each register needs its own PTU and a PTU does not transfer to a replacement device**). **Partially verified.**
- **CAS / CBA** (computerized accounting systems): RMC 5-2021 / RMO 9-2021 replaced PTU with an **Acknowledgement Certificate (ACK/AC)** issued within ~3 working days on a documentary checklist + post-audit. A vendor guide (Orkids, Jun 2026) claims PTU was removed for POS too — this **conflicts** with RMO 24-2023 (2023, later) and StoreHub's 2026 PTU-per-register guidance. Treat "POS uses PTU via eAccReg; CAS uses ACK" as the working assumption. **Unverified — confirm with BIR.**
- **ORUS** (Online Registration and Update System) is the BIR's general online registration portal (RMC 153-2022 etc.); EIS enrolment is reportedly done via ORUS. Exact flow of CRM/POS registration through ORUS vs eAccReg in 2026: **Unverified.**
- Revocation of a supplier's accreditation does not automatically revoke the user's PTU; user violations do. **Verified.**
- Machines used only for ordering (e.g., kiosks that don't issue invoices) are "Special Purpose Machines": no accreditation, but still need a PTU. **Verified.** → A Tilvara self-order kiosk or QR ordering that does not issue invoices still has a registration obligation.

**Tilvara implication:** Model `Terminal` with `min`, `ptu_number`, `ptu_date`, `serial/license_no`, `bir_status` (unregistered/pending/registered/revoked). A terminal cannot issue *invoices* until registered; before registration it can only run in "training/non-fiscal" mode that prints "NOT AN INVOICE". Device replacement = new terminal record, old one closed with final Z-reading. Provide merchant a PTU application document pack (sworn statements, sample receipts, Z-reading samples, terminal list).

### 4.3 BIR Public Advisory, 14 Sept 2026 — **Verified** (read the signed scan)
"…as of the date of this Advisory, it has not accredited, authorized, certified, recognized, or endorsed any entity as an official BIR ESP, partner, representative, or solution provider of electronic invoicing and sales reporting systems. Accordingly, no person or entity may represent … that it is accredited, authorized, recognized, endorsed by, or officially affiliated with the BIR as an ESP." BIR has temporarily suspended meetings/demos/consultations with ESPs pending the e-invoicing framework. Signed by Commissioner Charlito Martin R. Mendoza. (Copy hosted by KPMG PH.)

## 5. Electronic Invoicing System (EIS) mandate

| Item | Detail | Confidence |
|---|---|---|
| Legal basis | NIRC Sec. 237/237-A as amended by TRAIN, EOPT, **RA 12066 (CREATE MORE)**. | Partially verified |
| RR 8-2022 | Original EIS rules; sales data transmitted real-time/near real-time, **no later than 3 calendar days** after transaction. | Partially verified |
| RR 11-2025 | Current framework for e-invoicing + electronic sales reporting; covered taxpayers originally given 1 year (to ~14 Mar 2026). Head office and all branches of a covered taxpayer covered. Micro taxpayers excluded. E-invoices must be structured data (JSON/XML); PDFs allowed only if derived from structured source. | Partially verified |
| RR 26-2025 (5 Sep 2025) | Extended deadline to **31 Dec 2026** for: e-commerce taxpayers (non-micro), LTS taxpayers, Large Taxpayers per RR 8-2024, CAS/CBA/e-invoicing users. **POS users, exporters, and RBEs: mandatory only after BIR establishes the system and issues separate RRs** (no date). | Partially verified |
| RMC 98-2026 (2026) | Reportedly: covered taxpayers need a **Permit to Issue Electronic Invoice (PTI)** (head office + each branch; shared PTI number if same system; new/amended PTI on system change); separate **Permit to Transmit (PTT)** for sales reporting; **EIS Certification within 6 months after PTI**; during downtime issue BIR-authorized **manual invoices** then replace with e-invoice referencing the manual number; issued e-invoices cannot be edited — reductions via **credit note**, increases via new invoice; POS-printed invoices are **not** e-invoices unless the system can electronically issue/transmit to buyer and report to BIR. | **Unverified** (single secondary source: Taxumo, Sept/Oct 2026) |
| BIR ESP advisory | See §4.3 — no ESP accredited as of 14 Sep 2026. | Verified |

**Tilvara implication:** Tilvara's typical merchant (POS user, small/medium) is probably *not yet* mandated, but merchants who also sell online (e-commerce) or are CAS users may be covered by 31 Dec 2026. Build an `EInvoiceAdapter` interface now (structured JSON invoice model, transmission queue with retries, 3-day SLA monitor, credit-note/debit flows, downtime manual-invoice reconciliation), but **do not** build to a specific BIR API spec until the final technical specs are published. Keep invoice data model structured from day one so EIS export is a serializer, not a refactor.

## 6. VAT, VAT-exempt, zero-rated, percentage tax

| Item | Detail | Confidence |
|---|---|---|
| VAT rate | 12% on sale of goods/services (NIRC Sec. 106/108). Prices to consumers are typically VAT-inclusive. | Verified (common knowledge; cited in RR 5-2017 examples) |
| VAT registration threshold | ₱3,000,000 gross annual sales (TRAIN); below → non-VAT, percentage tax (3%) unless opted for 8% income tax. | Partially verified |
| Exempt / zero-rated | Must be labelled and broken out on invoice (mixed transactions). SC/PWD sales are VAT-exempt sales. | Verified (RMO 24-2023 list) |
| Percentage tax and SC/PWD | SC/PWD VAT exemption does **not** extend to percentage tax; for non-VAT sellers the 20% applies to the full price (RMC 38-2012; RR 5-2017 §5.1, §7.5). | Verified (NCDA copy of RR 5-2017) |

**Tilvara implication:** Tax engine with per-tenant registration type (VAT / NON-VAT), per-item tax class (VATable, exempt, zero-rated), VAT-inclusive pricing as default, effective-dated rates. All reports split VATable / exempt / zero-rated / VAT amount.

## 7. Senior Citizen (RA 9994) and PWD (RA 10754) — 20% discount + VAT exemption  ⚠ CRITICAL

### 7.1 The computation — **Verified** (RR 5-2017 for PWD, NCDA copy; RR 7-2010 uses the same method for SC per multiple sources)

**VAT-registered seller** (price is VAT-inclusive):
```
gross_vat_inclusive   = 1,120.00
vat_exempt_base       = 1,120.00 / 1.12          = 1,000.00   (VAT removed, not billed)
sc_pwd_discount       = 1,000.00 * 0.20           =   200.00
amount_due            = 1,000.00 - 200.00         =   800.00
```
- The discount is **20% of the VAT-exclusive price**, *not* 32% of the inclusive price and *not* 20% then remove VAT. (Mathematically identical result: `amount_due = price/1.12 * 0.8`.)
- Seller may not bill VAT to the SC/PWD. Input VAT attributable to the exempt sale becomes cost/expense.
- Seller records **Sales = 1,000 (VAT-exclusive gross)**, **SC/PWD Discount expense = 200**, Cash 800 — discount is a deductible expense, not a reduction of sales; the income tax base is 1,000.

**Non-VAT seller:**
```
gross          = 1,120.00
discount 20%   =   224.00
amount_due     =   896.00
percentage tax computed on 896.00 (3%) = 26.88
```

### 7.2 Rules that drive POS logic
- Applies only to the portion for the **exclusive use/consumption** of the SC/PWD. **Verified (RR 5-2017 §5.2).**
- **No double discount:** a PWD who is also an SC gets only one 20% per transaction. **Verified.** SC vs establishment promo: the law lets the SC choose the higher of the two (RA 9994 Sec. 4) — **partially verified**; pending bills to allow stacking with promos (HB 10061–10063, 2024) — status **unverified**.
- **Restaurants (RMC 38-2012):** covers food, drinks, desserts, consumables incl. value/promo meals, condiments; dine-in, take-out, take-home, **excluding bulk orders**; SC must be present, personally order, show valid ID. Phone/delivery: give ID number at order, show ID at delivery (DSWD 2009 resolution). **Partially verified.**
- **Group meals:** two practices exist — (a) identifiable individual orders → discount on the SC's own items; (b) shared/non-identifiable → total bill ÷ headcount × number of SC/PWD diners (DSWD 2009 resolution, secondary). **Partially verified.**
- **Quick-service / online-phone-SMS orders (RMC 71-2022 circularizing JMC 01-2022):** for QSR group orders the discount base is "the most expensive and largest single-serving meal with a beverage" — vendors implement this as an **MEMC (Most Expensive Meal Combo) base value** per store (StoreHub). **Partially verified** (DOJ opinion via Divina Law, Feb 2025; StoreHub help).
- **Records:** separate SC/PWD sales book per transaction: name, ID number, (TIN if any), gross sales, discount, date, invoice number. Missing name/ID → deduction disallowed. **Verified (RR 5-2017 §5.9; RR 11-2015 for SC).**
- **Invoice:** gross price and discount shown **separately**; VAT-exempt sales segregated from taxable on the tape. **Verified.**
- **5% discount on basic necessities & prime commodities** (groceries, separate from the 20%): capped (JMC 01-2022 cited **₱1,300/week**, later rules e.g. DTI-DA-DOE JAO 24-02 revised the caps — **unverified current value**). Not VAT-exempt. Relevant to retail/sari-sari/grocery tenants.
- Utilities (electric/water) excluded from SC VAT exemption (RR 8-2010) — not relevant to POS.

### 7.3 Solo Parent (RA 11861, RR 1-2023, 17 Jan 2023) — **Partially verified**
10% discount **+ VAT exemption** on baby's milk, food & micronutrient supplements, sanitary diapers, medicines, vaccines, medical supplements — for exclusive use of the child aged ≤6; parent income < ₱250,000/yr (eligibility checked by the ID, not the POS); show Solo Parent ID + booklet; gross price and discount shown separately. Generally **not** restaurant meals. Computation presumed analogous (remove VAT, then 10%) — **unverified**; StoreHub states SP discounts are computed with VAT removed first.

### 7.4 National Athletes & Coaches (NAAC, RA 10699) — **Partially verified**
20% discount on transportation, hotels, **restaurants**, recreation, sports equipment, medicine for actual and exclusive use; ID = PNSTM/National Sports Team Member card (+ PSC booklet). RMO 24-2023 lists NAAC fields on invoices. Whether NAAC purchases are **VAT-exempt** and the exact computation: **Unverified** — do not assume VAT exemption; make it a config flag defaulting to "confirm with tax adviser".

### 7.5 Tilvara implementation implications
- `DiscountScheme` table (effective-dated): `code` (SC, PWD, NAAC, SOLO_PARENT, SC_5PCT_BNPC), `rate`, `vat_exempt` (bool), `base` (`VAT_EXCLUSIVE` | `GROSS`), `eligible_item_categories`, `weekly_cap`, `requires_id`, `requires_signature` (in-store yes, online no), `requires_tin_if_any`, `stackable_with_promo` (default false, "choose higher").
- Line-level allocation: the cashier selects which lines (or which share for group meals) belong to each discount holder; supports modes `ITEMIZED`, `PRORATED_BY_HEADCOUNT`, `MEMC_BASE_VALUE`.
- Compute in integer centavos; rounding rule **configurable** (per line vs per invoice; half-up) — **rounding is unverified, needs tax adviser.**
- Interaction with **service charge** (is SC/PWD's share of service charge discounted/VAT-exempt?) — **unverified; tax-adviser question.**
- Manager PIN override, mandatory capture of ID number + name per beneficiary, signature line printed; SC/PWD/NAAC/SP sales books in back office; Z-reading shows discount totals by type and VAT-exempt sales.
- Reject double-application on the same line; enforce "exclusive use" by requiring line assignment.

## 8. Service charge — RA 11360 (2019) — **Partially verified**
- Service charges collected by hotels, restaurants, and similar establishments must be distributed **100%** **equally** among covered (non-managerial) employees (previously 85/15). DOLE **DO 242-2024** (effective 1 Feb 2024) replaced DO 206-2019: distribution at least twice a month, no more than 16 days apart; reportedly covers agency/contractual workers and distribution by actual hours/days worked.
- Tips/gratuities voluntarily given are separate (not "service charge") — treatment **unverified**.
- **Tilvara implication:** service charge is a separate, configurable charge line (rate, applies to dine-in/takeout, taxable VAT status configurable — VAT on service charge commonly applied; **confirm**), never merged into item price; report "service charge collected per period" to support DOLE distribution; optional per-employee hours import for distribution calculation (P2).

## 9. Data Privacy Act of 2012 (RA 10173) and NPC rules — **Partially verified**
- Tilvara is a **Personal Information Processor (PIP)** for merchants' customer data (and a Personal Information Controller for its own users/billing data). Merchants are PICs. SC/PWD ID numbers, names, signatures, and **PWD disability info** — PWD status may be **sensitive personal information** (health-related) → minimize: store ID number + name only, never disability type.
- **NPC Circular 2022-04** (effective 11 Jan 2023): registration of DPO and data processing systems via online portal; mandatory if ≥250 employees, **or** processing is likely to pose risk, is not occasional, or involves sensitive personal info of ≥1,000 individuals; otherwise file a sworn declaration (Annex 1). Registration valid 1 year (renew). New systems registered within 20 days of commencement. Tilvara as a multi-tenant SaaS processing data for many merchants should assume it **must register** and appoint a DPO. Check whether Circular 2022-04 has since been amended.
- **NPC Circular 16-03**: breach notification to NPC and affected data subjects within **72 hours** of knowledge/reasonable belief; obligation stays with the PIC even if outsourced → Tilvara must notify merchants fast enough for them to meet 72h (contract: "without undue delay, target ≤24h").
- Need: Data Processing Agreement (PIC–PIP outsourcing agreement) template, privacy notice, data subject rights tooling (access, correction, erasure — but erasure conflicts with BIR 5-year retention: retain fiscal records, pseudonymize elsewhere), security measures (encryption at rest/in transit, access logs).
- Sources: privacy.gov.ph Circular 2022-04 PDF; NPC resolutions quoting Circular 16-03; law-firm summaries.

## 10. PCI DSS — **Partially verified**
- PCI DSS **v4.0.1** is current; the 51 "future-dated" requirements became mandatory **31 Mar 2025** (PCI SSC). E-commerce payment-page script requirements 6.4.3 / 11.6.1 affect web checkout.
- **Tilvara implication:** Never touch raw PAN. Use PH acquirers/terminals with semi-integrated or P2PE terminals (card data stays on the terminal) and hosted/redirect payment pages for online ordering (target SAQ A / SAQ P2PE scope for merchants; Tilvara as a service provider minimizes scope). QR Ph / GCash / Maya flows are not card data but still need secure webhook handling and reconciliation.

## 10A. Pharmacies and drugstores (session 30, ADR-0025) — **Unverified: for the pharmacist-in-charge, the DPO and the tax adviser**
Tilvara records what the rules below seem to need. None of it is confirmed with FDA, DOH, PDEA/DDB or the PRC, and the product makes no compliance claim for pharmacies.
- **Prescription medicines** (RA 10918 Philippine Pharmacy Act and its IRR; RA 6675 Generics Act; DOH antibiotic stewardship). *Assumed:* Rx and antibiotic medicines are dispensed only against a prescription, the pharmacy keeps a record of each dispensing (patient, prescriber and PRC licence number, date, medicine in generic name, quantity, pharmacist), a prescription may be filled in parts, and the pharmacist may dispense a generic or brand equivalent of what was prescribed (same generic name, strength and dosage form). **To confirm:** the prescription book's required fields and format; how long dispensing records are kept (Tilvara assumes the fiscal period at least; the retention schedule leaves it to the DPO); whether antibiotics need anything beyond an ordinary prescription; whether a pharmacy assistant may hand over Rx medicines under the pharmacist's supervision (Tilvara asks for the pharmacist's approval at the till).
- **Dangerous drugs** (RA 9165 Comprehensive Dangerous Drugs Act; DDB regulations). *Assumed:* dispensed only by a licensed pharmacist against the DOH yellow prescription form with the prescriber's S2 licence number, the patient's name and address; **one full fill per yellow form, no partial fills or refills**; the pharmacy keeps a dangerous drugs register (opening, received, dispensed, closing per drug) and reports it. Tilvara never dispenses them offline. **To confirm:** the register format and reporting period, partial fills, which items the business must class as dangerous (the business classes its own items; Tilvara keeps no official list).
- **Expired and recalled medicines** (FDA rules on dispensing expired products; FDA advisories). *Assumed:* expired medicines may not be sold; recalled batches are held and returned or destroyed. Tilvara refuses an online sale that could only be filled from expired or held lots at a branch that blocks them (default for a pharmacy) and flags offline sales that drew them. **To confirm:** whether the expiry date is the last day of the stated month when only a month is printed (Tilvara takes the date as entered).
- **Batch (lot) numbers**: a medicine received with an expiry date must carry its lot number in Tilvara, so a batch can be traced to the sales that took it. Receipts print the lot and expiry per medicine line. **To confirm:** whether a pharmacy's sales invoice must show the lot.
- **SC/PWD on medicines** (RA 9994 and its IRR; RA 10754; DOH AO 2010-0032 and later issuances). *Assumed:* the 20 % discount and VAT exemption apply to medicines for the beneficiary's exclusive use, on presentation of the OSCA/PWD ID, the **purchase booklet** (where still required) and, for Rx medicines, the prescription; the pharmacy records the purchase in the booklet. The booklet requirement has changed over the years, so Tilvara records whether it was presented and lets the business decide whether it is required (default: required). **To confirm:** the current booklet rule; any weekly or per-purchase quantity limits for medicines.
- **VAT-exempt medicines** (NIRC Sec. 109 as amended by TRAIN and CREATE; FDA lists of exempt medicines for diabetes, high cholesterol, hypertension, cancer, mental illness, tuberculosis, kidney disease). The business sets these items' tax category to VAT-exempt; SC/PWD on them is 20 % of the price, as for any VAT-exempt item (§7). **To confirm:** the current lists and how often they change.
- **Not covered**: maximum drug retail prices (EO 104 and later MDRP lists), e-prescriptions, FDA/DDB online reporting, compounding records.

## 11. Other items to watch (not researched in depth)
- **Mall sales reporting**: lease contracts at SM, Ayala, Robinsons, Megaworld etc. commonly require POS sales files sent to the mall daily (Mosaic advertises "mall accredited"). Not a law, but a hard commercial requirement for mall tenants. **Unverified specifics.**
- LGU business permits, DTI price tag law (RA 71), Consumer Act; Internet Transactions Act (RA 11967) if Tilvara offers online ordering; FDA for pharmacies.
- Withholding tax on payments to Tilvara (merchant side) — not POS logic.

---

## Questions requiring a PH tax professional or direct BIR confirmation

1. For a **cloud SaaS POS** (subscription), which track applies: RMO 24-2023 POS software accreditation, the "e-invoicing/e-receipting under subscription-based agreement" (ATG) track, EIS certification, or several? Given the 14 Sep 2026 advisory suspending ESP engagements, can a new supplier apply for POS accreditation now?
2. Does each **merchant terminal** still require a PTU + MIN via eAccReg in 2026, or has it moved to ORUS / Acknowledgement Certificate? Is a **tablet/phone browser or PWA** acceptable as a "cloned/software POS" and what serial is printed (license number per terminal?).
3. Does a **web-based multi-device** setup (one store, several tablets) need one MIN/PTU per device and a separate invoice series per device? Can devices share a series if online-only? (We assume one series per device.)
4. Which of our planned release changes are "**major enhancements**" requiring re-accreditation? Can we accredit a frozen fiscal core and iterate UI freely?
5. Exact Z-reading / X-reading / eJournal / backend report **field formats** (the TWG Functional & Technical Evaluation Checklist), Accumulated Grand Total digit length, and eJournal file format.
6. **Rounding** rule for SC/PWD computations (per line vs per invoice; centavo rounding).
7. SC/PWD discount interaction with **service charge**, delivery fees, packaging fees, and **promo/bundle** prices; current group-meal rule for **dine-in** full-service restaurants vs QSR MEMC.
8. NAAC: VAT-exempt or not? Computation base?
9. Current **5% BNPC** cap and covered item list for SC/PWD (post JAO 24-02).
10. Is the ₱500 non-VAT invoice threshold "more than ₱500" or "₱500 or more", and has the CPI adjustment been applied (next ~Jan 2027)?
11. When POS users become EIS-mandated, what will be the transmission spec; and are tenants who also sell online through Tilvara (e-commerce) already covered by the 31 Dec 2026 deadline?
12. Is RMC 98-2026 (PTI/PTT/downtime rules) authentic and what does it say verbatim?
13. Retention: 5 years (EOPT) vs any longer requirement for e-journals or sales machines?
14. Offline operation: is issuing invoices from a disconnected terminal (later sync) acceptable for accredited POS? (We believe yes since non-volatile local storage is required, but confirm.)
15. VAT treatment of service charge; tips.
16. NPC: does Tilvara need DPS registration as a PIP, and are merchants required to register because of SC/PWD data?
17. Pharmacies (§10A): the prescription book and dangerous drugs register formats and retention; partial fills of yellow prescriptions; the current SC/PWD purchase booklet rule for medicines; whether the lot must appear on the invoice. (Pharmacist-in-charge and DPO; tax adviser for the booklet and VAT-exempt lists.)

## Release gates (must all pass before selling to PH merchants as an invoicing POS)

- **G0 — Legal review:** PH tax counsel signs off on this document's assumptions (answers to Q1–Q8 at minimum).
- **G1 — No false claims:** Marketing, website, sales decks, app store listing reviewed; no "BIR-accredited/certified/compliant/authorized" wording until certificate in hand; certificate number displayed only after verification on official BIR channel.
- **G2 — Fiscal core complete:** gapless per-terminal invoice series w/ reset counter, separate transaction series, accumulated grand total, append-only hash-chained e-journal, X/Z readings, backend reports, SC/PWD/NAAC/SP sales books, void/return series, reprint marking, data retention ≥5y, tamper detection — all with automated tests including offline/resync and clock-skew scenarios.
- **G3 — Tax engine tests:** golden test vectors for VAT-registered and non-VAT SC/PWD computations (₱1,120 → ₱800; ₱1,120 → ₱896), mixed-cart breakdowns, group-meal modes, MEMC, rounding — reviewed by a CPA.
- **G4 — Accreditation:** BIR Certificate of Accreditation (or applicable equivalent) for the exact software version obtained; fiscal core version pinned.
- **G5 — Merchant onboarding:** PTU/MIN capture flow; terminals blocked from issuing invoices until registered; training mode prints "NOT AN INVOICE".
- **G6 — Privacy:** NPC registration/DPO decision documented; DPA template; privacy notice; 72h breach runbook; PWD data minimization.
- **G7 — Payments:** card data never stored/processed by Tilvara servers; PCI scope documented with payment partner.
- **G8 — Change control:** any change to fiscal core requires compliance sign-off and an assessment of "major vs minor enhancement".

---

## Sources
- BIR — RMO No. 24-2023 Digest (official): https://bir-cdn.bir.gov.ph/local/pdf/RMO%20No.%2024-2023%20Digest%20FINAL.pdf
- BIR Public Advisory, 14 Sept 2026 (ESP claims), hosted by KPMG PH: https://assets.kpmg.com/content/dam/kpmgsites/ph/pdf/InTAX/2026/EIS-Public-Advisory-Sep-2026-redacted.pdf
- NCDA copy of RR 5-2017 (PWD, RA 10754): https://ncda.gov.ph/?p=7758
- Grant Thornton — RMC 77-2024 clarification: https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/clarification-on-the-invoicing-requirements-per-rr-no-7-2024-as-amended-by-rr-no-11-2024/
- Grant Thornton — EoPT dates for CAS taxpayers: https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/invoicing-requirements-under-the-eopt-act/
- MTF Counsel — invoicing requirements (May 2025): https://mtfcounsel.com/2025/05/08/how-to-comply-with-the-birs-invoicing-requirements/
- PwC — EOPT alert: https://pwc.com/ph/en/tax/tax-alerts/2024/pwc-ph-ease-of-paying-taxes-2024.pdf
- Grant Thornton — EOPT book preservation: https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/eopt-is-here-updates-on-the-preservation-of-book-of-accounts-and-changes-in-taxpayer-registration/
- PwC Tax Alert 22 (RMC 72-2025): https://www.pwc.com/ph/en/tax/tax-publications/tax-alerts/2025/tax-alert-22.html
- Fiscal Requirements — who must comply by 31 Dec 2026: https://www.fiscal-requirements.com/news/5954-philippines-e-invoicing-which-businesses-must-comply-by-december-31-2026
- Sovos — EIS deadline extension: https://sovos.com/regulatory-updates/vat/philippines-deadline-for-mandatory-structured-e-invoicing-extended/
- Taxumo — RMC 98-2026 explainer: https://www.taxumo.com/blog/bir-eis-explained-new-pti-and-downtime-rules-under-rmc-no-98-2026/
- Orkids — "BIR-accredited POS 2026" (vendor; PTU/ACK claim): https://orkids.ph/guides/bir-accredited-pos
- StoreHub — BIR compliance quick start (Jul 2026): https://care.storehub.com/en/articles/13223804-ph-storehub-bir-compliance-updates-quick-start-guide
- StoreHub — MEMC SC/PWD: https://care.storehub.com/en/articles/12252232-ph-how-to-set-up-and-apply-memc-discounts-for-senior-citizens-and-pwds
- Divina Law / Daily Tribune — PWD discount to group meals (Feb 2025): https://tribune.net.ph/2025/02/06/pwd-discount-to-group-meals
- Grant Thornton — online SC/PWD purchases; signature not required: https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/signature-of-scs-and-pwds-on-qualified-transactions-on-online-purchases-no-longer-required/
- KPMG — RMC 71-2022 VAT exemption online: https://home.kpmg/us/en/home/insights/2022/08/tnf-philippines-vat-exemption-senior-citizens-persons-with-disabilities-online-purchases.html
- RR 7-2010 (lawyerly mirror): https://dev.lawyerly.ph/laws/55830 ; RR 11-2015: https://dev.lawyerly.ph/laws/91865
- RMC 38-2012 (Davao City OSCA copy): https://seniorcitizen.davaocity.gov.ph/index.php/republic-act-9994-page-4
- DSWD restaurant resolution summary: https://jur.ph/law/summary/resolution-clarifying-senior-citizens-discount-restaurants
- RA 10699 (Senate): https://legacy.senate.gov.ph/republic_acts/ra%2010699.pdf
- Solo parent RR 1-2023: https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/welcome-relief-tax-entitlements-for-solo-parents/ ; https://mb.com.ph/2023/2/21/bir-solo-parent-now-entitled-to-10-discount-of-goods-for-their-kids
- RA 11360 IRR (DO 206): https://issuances-library.senate.gov.ph/sites/default/files/2021-08/RA%2011360%20IRR.pdf ; DO 242-2024: https://tribune.net.ph/2024/05/02/new-guidelines-for-service-charge
- NPC Circular 2022-04: https://privacy.gov.ph/wp-content/uploads/2023/05/Circular-2022-04.pdf
- NPC breach (Circular 16-03 quoted): https://privacy.gov.ph/wp-content/uploads/2024/08/NPC-BN-20-124-2020.08.06-In-re-E-Science-Corporation-Resolution.pdf
- PCI SSC — future-dated requirements: https://blog.pcisecuritystandards.org/coffee-with-the-council-podcast-guidance-for-pci-dss-e-commerce-requirements-effective-after-31-march-2025
- Respicio — POS audit trail commentary: https://www.respicio.ph/commentaries/audit-trail-requirements-for-pos-accreditation-in-the-philippines
