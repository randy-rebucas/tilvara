# 1POS — Competitor Analysis (Philippines-first hybrid retail + restaurant POS)

Research date: **2026-10-15**. All prices are "as seen on 2026-10-15" at the cited URL unless stated otherwise. Anything not confirmed from the vendor's own page or a reliable independent source is marked **UNVERIFIED**. Claims by one vendor about a rival (e.g., StoreHub blog posts about Loyverse/UTAK/Mosaic) are treated as **UNVERIFIED** competitor marketing. "BIR-accredited" claims are the vendor's own claims — note the BIR's 14 Sep 2026 advisory that no *e-invoicing* service provider is accredited (see `docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md` §4.3); POS-machine accreditation under RMO 24-2023 is a different track.

## 1. Summary matrix

| Vendor | Serves PH? | Pricing (seen 2026-10-15) | Offline | Restaurant depth | Inventory depth | BIR claim |
|---|---|---|---|---|---|---|
| Shopify POS | Software usable; **Shopify Payments not available in PH** (official list) | Basic $25 / Grow $65 / Advanced $399 / Plus $2,300 (3-yr) per month; **POS Pro $89/location/mo billed yearly** | Offline card payments only with Shopify Payments + supported readers; cash works | Weak (retail-first) | Good retail multi-location (POS Pro) ; no recipes | None found |
| Square | **No card processing in PH** (official list: US, CA, AU, JP, UK, IE, FR, ES) | n/a for PH | Offline cards: 24h session, upload within 72h, merchant bears declines | Square for Restaurants (not in PH) | Moderate | None |
| Lightspeed Restaurant / Retail | **UNVERIFIED / likely not** (PH absent from third-party country lists) | Restaurant: Starter $69 / Essential $189 / Premium $399 USD/mo; KDS $30/screen/mo. Retail X-Series: $89 / $149 / $289 USD/mo | "Offline mode" listed (restaurant) | Strong (full-service) | Strong retail; "advanced inventory" incl. prep (restaurant) | None |
| Toast | **No** — US, Canada, Ireland, UK, Australia | Starter Kit $0, Point of Sale $69/mo, Build Your Own custom (secondary sources, **partially verified**); processing ~2.49%+$0.15 | Offline mode: orders + card payments with background processing; pre-auth fails; post-reconnect declines possible | Very strong | Strong (restaurant) | None |
| Loyverse | Yes (global free app; widely used by PH micro-SMEs) | Core free; Unlimited history $5/store/mo; Employee mgmt $5/employee/mo; Advanced inventory $25/store/mo (USD) | Good: sells offline, receipts held locally; no refunds, no integrated card terminals, no stock levels offline | Basic (KDS, open tickets, modifiers) | Basic; composite items/POs in paid add-on | Reportedly **not** on BIR list as of 2023 (**UNVERIFIED**, competitor source) |
| StoreHub (PH) | Yes, PH-focused | Starter from ₱2,249 / Advanced ₱4,499 / Pro ₱8,999 per month; 1 register + 1 store included; extra registers/stores add-on; 12/24/36-mo terms | "Sell offline & online" — specifics not published | Good F&B: SC/PWD/SP discounts, MEMC, delivery integration (GrabFood, foodpanda, ShopeeFood) | Advanced: multi-location, stock transfer, alerts | Claims BIR-accredited; generates Z/X-reading, E-Journal, BIR Sales Summary; PTU per register |
| Mosaic (MosaicPOS) | Yes, PH | Not published; StoreHub claims "from ₱2,000/mo for 2 yrs" & hardware from ₱10,459 (**UNVERIFIED**) | Claims works offline | F&B focus, food courts, franchises | Recipe-based auto-deduct, branch/company views | Claims **BIR and mall accredited** |
| UTAK | Yes, PH | Not published; 2023 StoreHub figures ₱14,000 first 6 mo then ₱1,500/mo (**UNVERIFIED, stale**) | Claimed offline (Klikit, **UNVERIFIED**) | F&B tablet POS | Auto-deduct inventory; attendance; payroll claimed (**UNVERIFIED**) | StoreHub claims not on BIR list as of 2023 (**UNVERIFIED**); UTAK job post mentions BIR permit processing for clients |
| Qashier | Yes, PH (also SG/MY) | ~₱2,500/mo per Klikit (**UNVERIFIED**) | **UNVERIFIED** | QSR focus | **UNVERIFIED** | Own blog claims BIR-accredited; has help docs on PH special discounts & audit reports |
| Klikit | Yes, PH | Claims from ₱999/mo (own marketing, **UNVERIFIED**) | **UNVERIFIED** | Delivery-aggregator-centric (GrabFood, foodpanda, ShopeeFood); GCash/Maya QR | **UNVERIFIED** | Claims "BIR-compliant invoicing" |
| Maya POS (Maya Business) | Yes, PH | **UNVERIFIED** | **UNVERIFIED** | Payment-centric for stalls/retail | Light | **UNVERIFIED** |

Hardware ecosystems: Shopify (POS Go, POS Terminal, Tap & Chip readers — PH availability **UNVERIFIED**); Square (own readers/Stand/Terminal, not sold in PH); Toast (proprietary Android hardware, contract-bundled); Lightspeed (iPad + partner hardware); Loyverse (any Android/iOS + generic ESC/POS printers); StoreHub (sells hardware bundles; hardware page not priced); Mosaic (range of devices, own bundles); UTAK (tablet bundles). PH local vendors generally sell hardware + BIR registration assistance as a package (e.g., StoreHub cites ₱1,000 registration help; UTAK via partner ₱4,000 — **UNVERIFIED**, StoreHub blog).

## 2. Per-competitor notes

### Shopify POS
- **Target:** omnichannel retailers with a Shopify online store.
- **PH:** Shopify Payments not supported in PH (Asia-Pacific list: AU, CN, HK, JP, NZ, SG) → in-person card payments need third-party providers, losing integrated offline card acceptance. PH merchants use HitPay/ShopeePay-type gateways online (third-party).
- **Offline:** Offline card payments require app ≥9.14.0, specific readers, staff permission, device daily and per-transaction limits; no swipe, no tap-to-pay, no manual entry offline; declines discovered after reconnect.
- **Restaurant:** essentially none (no tables/KDS/course firing natively).
- **Inventory:** multi-location, transfers via POS Pro; no ingredient/recipe depletion natively.
- **Integrations:** huge app ecosystem.
- **BIR:** nothing found; would require local add-ons.

### Square
- Not operational for payments in PH. Offline mode reference design: 24h offline session, 72h upload deadline, per-transaction offline cap ($1–$50,000), pending offline payments lost if user signs out / reinstalls, no close-of-day reporting offline. Useful as a cautionary pattern for 1POS offline design.

### Lightspeed (Retail X-Series, Restaurant)
- **Target:** mid-market independent retailers and full-service restaurants in NA/EU/AU.
- **PH:** not found on country lists (Cloudbeds third-party list; Lightspeed says "100+ countries" without naming) — **UNVERIFIED**.
- **Restaurant:** full-service, KDS ($30/screen), "advanced inventory: track, order, receive, prep". Recipe costing not explicit on pricing page.
- **Retail:** strong inventory, wholesale/NuORDER catalog, landed costs, API, SSO on all plans.

### Toast
- **Target:** US-style restaurants of all sizes; proprietary hardware; mandatory Toast payments.
- **PH:** not available (markets: US, CA, IE, UK, AU as of Mar 2026).
- **Pain points (reviews):** slow support escalation, 2–3 year contracts with auto-renew and early-termination fees, hardware lock-in, add-on fees, outage incidents with payments.
- **Offline:** among the best — keep taking orders and cards; KDS backup printing; pre-auth fails offline.

### Loyverse
- **Target:** micro and small shops/cafés worldwide; very popular with PH micro-SMEs because the core is free.
- **Offline:** POS sells offline, receipts marked "Unsynced", auto-sync later; cannot sign out with unsynced receipts; **offline: no refunds, no new customers, no integrated card terminals, no stock levels, open tickets don't sync between devices**.
- **Pain points (aggregated reviews, rfp.wiki):** inventory not always accurate, stock-take timeouts, instability/slow performance, weak support for outages, costs rise with add-ons and multiple stores.
- **BIR:** competitor says not accredited (2023) → users must handwrite invoices. **UNVERIFIED** today; no Z-reading/SC-PWD info found from Loyverse itself.

### StoreHub (PH)
- **Target:** PH SMB retail and F&B chains; strongest local feature parity with BIR flows.
- **BIR features (own docs, Jul 2026):** BIR sales-invoice receipt format with MIN, serial, permit number, running invoice #; Z-Reading, X-Reading, E-Journal, BIR Sales Summary; void/return separate series; SC/PWD/Solo Parent discounts with VAT removed first; MEMC base value for restaurants; manager PIN for special discounts; **PTU per register, not transferable to replacement device**.
- **Notable weakness found in their own docs:** *enabling BIR compliance permanently removes existing transactions from that store* — i.e., compliance mode is a destructive migration, not a first-class design.
- Delivery integrations (GrabFood, foodpanda, ShopeeFood) with BIR handling.
- Pricing per register/store add-ons; long-term contracts encouraged.

### Mosaic POS
- **Target:** PH F&B (restaurants, cafés, bars, bakeries, food trucks, food courts), retail, franchises.
- Claims: offline, recipe-based auto-deduct inventory, branch/company views, GrabFood/foodpanda orders, GLife, per-transaction QR payments, support 7am–midnight. Accounting integrations Xero/QuickBooks/Navision (StoreHub claim, **UNVERIFIED**). Claims **BIR + mall accreditation** — the mall angle is a real PH differentiator.

### UTAK
- Local F&B tablet POS; auto-deduct inventory, attendance, expense tracking; payroll and offline **UNVERIFIED**; no loyalty (competitor claim). Pricing unpublished.

### Qashier, Klikit, Maya POS
- Qashier: own help center covers PH special discounts, receipts and audit reports; claims BIR-accredited and assists merchants in filing.
- Klikit: aggregator-led, integrates delivery platforms, GCash/Maya QR, low entry price claim.
- Maya POS: payments-first; good for cashless micro-merchants.

## 3. Table-stakes features (PH market, 2026)
1. Fast checkout on Android tablets/phones and low-cost hardware; ESC/POS 58/80mm thermal printers, cash drawer, barcode scanner.
2. **BIR-format sales invoices** with MIN, serial, PTU, supplier accreditation info; **Z-reading, X-reading, e-Journal, BIR sales summary/backend reports**; void/refund series.
3. **SC/PWD (20% + VAT exempt), Solo Parent, NAAC discounts** with ID capture, sales books, group-meal handling (MEMC).
4. Cash + **QR Ph / GCash / Maya** + cards; split payments.
5. Offline selling with later sync.
6. Product variants/modifiers, open tickets/tabs, table management, kitchen printer/KDS.
7. Inventory with auto-deduct (recipes for F&B), purchase orders, stock transfers, multi-branch.
8. GrabFood / foodpanda / ShopeeFood order injection.
9. Shift/cash management, employee roles and PINs, manager overrides.
10. Cloud back office with sales reports; loyalty/CRM basics.
11. Local support (Taglish, long hours) and onboarding incl. **BIR PTU registration assistance**.

## 4. Where competitors are strong
- **Toast / Lightspeed:** restaurant operations depth (coursing, KDS, menus, labor), polished hardware, reliable offline (Toast).
- **Shopify:** omnichannel e-commerce + POS, ecosystem.
- **Loyverse:** price (free core), ease of use, offline basic selling.
- **StoreHub:** PH BIR workflow completeness, delivery integrations, F&B special discount handling, brand/scale (20,000+ customers claimed).
- **Mosaic:** F&B + mall accreditation + franchise/food-court setups.

## 5. Common operational pain points (from reviews/docs found)
- **BIR compliance bolted on:** StoreHub's BIR mode wipes prior transactions on enablement; PTU tied to physical register, replacement device = new PTU paperwork.
- **Offline is partial:** Loyverse can't refund, see stock, or run card terminals offline; open tickets don't sync between devices offline (a real problem for multi-tablet restaurants during ISP outages). Square/Shopify offline cards carry decline risk and time limits.
- **Inventory accuracy:** Loyverse reviews cite inaccurate tracking and stock-take timeouts; advanced inventory is a paid add-on.
- **Cost creep:** add-ons per register/store/employee (Loyverse, StoreHub, Lightspeed KDS per screen); long contracts with ETFs (Toast).
- **Support:** slow escalations (Toast), outage handling (Loyverse).
- **Accreditation ambiguity:** competing vendors accuse each other of not being on the BIR list; merchants can't easily verify.
- Reddit/PH forum evidence could not be fetched (reddit.com not accessible) — **UNVERIFIED** gap; do user interviews.

## 6. Gaps relevant to Philippine businesses
1. **True hybrid retail + restaurant** in one tenant (e.g., café with retail shelf, bakery, grocery with carinderia, resto with pasalubong section) — most local players are F&B-first or retail-first.
2. **BIR fiscal core as first-class design** (append-only, per-terminal gapless series, verifiable e-journal) instead of a destructive "compliance mode" toggle; **EIS-ready structured invoice data** for the coming mandate.
3. **Robust multi-device offline** (LAN peer sync between tablets so open tickets/KDS keep working without internet) — brownouts/ISP outages are common.
4. **Correct SC/PWD handling for dine-in group meals** (itemized, pro-rata by headcount, MEMC) with audit-ready sales books.
5. **Mall sales-file integrations** (SM, Ayala, Robinsons, Megaworld, etc.) — only Mosaic advertises it.
6. **Transparent pricing** without per-register surprises; local payment rails (QR Ph, GCash, Maya) built in.
7. **Franchise / commissary** flows (central kitchen → branch transfers, royalty reporting).
8. **Service-charge distribution report** (RA 11360) for restaurants.
9. **Accountant-friendly exports** (BIR-format sales books, VAT breakdown) for the merchant's CPA.

## 7. Features that could justify switching to 1POS
- Non-destructive, auditable BIR fiscal core + "show your RDO" compliance pack (sample invoices, Z-readings, sales books) — once accredited.
- Offline-first with LAN sync across tablets/KDS (works through brownouts with a UPS'd router).
- One system for retail + F&B with recipe-level inventory, unit conversions, waste, and commissary.
- SC/PWD group-meal wizard that prevents over/under-discounting and prints the correct breakdown.
- Mall sales reporting connectors for mall tenants.
- Simple flat PH pricing incl. extra devices; free migration from Loyverse/StoreHub (CSV import of products/customers).
- EIS-ready: when POS users are mandated, flip on transmission without changing systems.

## 8. Too expensive/complex for initial release
- Own branded hardware, card terminals, or becoming a payment facilitator.
- Full EIS transmission integration (spec not final; BIR suspended ESP engagements as of 14 Sep 2026).
- Mall integrations beyond 1–2 malls (each mall has its own format/process — **UNVERIFIED**).
- Native delivery aggregator integrations (partner programs, approvals) — start with manual/aggregator middleware.
- Payroll, full accounting/GL, e-commerce storefront, kiosk/self-order with payments, advanced labor scheduling, AI forecasting, multi-country tax.
- Native Windows/Tauri desktop builds (also blocked locally on Rust toolchain).

## 9. Prioritized differentiation roadmap

**P0 (MVP / pilot, before charging PH merchants)**
- Fiscal core: per-terminal gapless invoice series + reset counter, separate txn series, accumulated grand total, hash-chained e-journal, X/Z readings, backend reports, void/return series — behind a release gate (no live invoicing until accreditation + PTU).
- Tax engine: VAT/non-VAT, VATable/exempt/zero-rated, configurable effective-dated rules; SC/PWD/SP/NAAC discounts with ID capture and sales books; group-meal modes (itemized, headcount pro-rata, MEMC).
- Offline-first single-device selling with local persistence and safe sync; hybrid catalog (retail SKUs + menu items with modifiers).
- Restaurant basics: tables/open tickets, kitchen printer routing; retail basics: barcode, variants.
- Inventory: stock ledger, recipes/BOM auto-deduct, multi-branch, transfers.
- Payments: cash, QR Ph/GCash/Maya via partner (manual reference capture acceptable in P0), split tender.
- Service charge as separate line + report.
- Onboarding pack for PTU registration; honest compliance messaging.

**P1 (first 6–9 months after pilot)**
- LAN multi-device sync (open tickets, KDS) during internet outage.
- KDS, coursing, split bills, reservations-lite.
- Purchase orders, suppliers, unit conversions, waste, stock counts; commissary/central kitchen.
- Delivery aggregator order ingestion (via middleware), loyalty, customer accounts.
- 1–2 mall sales-file connectors; accountant exports (sales books, VAT summary).
- Integrated card terminal via a PH acquirer (semi-integrated, PCI scope minimized).

**P2 (later)**
- EIS transmission adapter once BIR publishes final specs for POS users.
- Franchise/royalty reporting, multi-brand, API/webhooks marketplace.
- Self-order kiosk / QR table ordering (note: ordering machines still need a PTU).
- Labor scheduling/service-charge distribution by hours; payroll integrations; forecasting.
- Expansion beyond PH (pluggable tax/fiscal modules).

## Sources (all accessed 2026-10-15)
- Shopify POS pricing (PH): https://www.shopify.com/ph/pos/pricing
- Shopify Payments supported countries: https://help.shopify.com/en/manual/payments/shopify-payments/supported-countries
- Shopify offline payments: https://help.shopify.com/en/manual/sell-in-person/shopify-pos/selling-offline/offline-payments
- Square international availability: https://square.com/help/us/en/article/4956 ; Square Seller Community (PH): https://www.sellercommunity.com/t5/Using-Square/Does-square-work-in-the-Philippines/m-p/26204
- Square offline mode: https://squareup.com/help/us/en/article/7777-process-card-payments-with-offline-mode
- Lightspeed Restaurant pricing: https://www.lightspeedhq.com/pos/restaurant/pricing/
- Lightspeed Retail pricing: https://www.lightspeedhq.com/pos/retail/pricing/
- Lightspeed country availability (third-party): https://myfrontdesk.cloudbeds.com/hc/en-us/articles/17210868640923-Available-versions-and-functionality-of-Lightspeed
- Toast pricing (secondary): https://www.nerdwallet.com/business/software/reviews/toast-pos ; https://www.owner.com/blog/toast-pricing ; https://costbench.com/changelog/toast-pos-plan-added-2026-02/
- Toast markets: https://transcripts.platformaeronaut.com/summaries/morgan-stanley-conference-2026-03-03-TOST ; https://www.nasdaq.com/articles/australia-launch-amex-deal-will-tosts-recipe-fuel-its-growth-engine
- Toast offline mode: https://support.toasttab.com/en/article/Prepare-to-Operate-in-Offline-Mode-During-Service-Disruptions-or-Outages
- Toast reviews: https://www.capterra.com/p/136301/Toast-POS/reviews/?page=10 ; https://www.rfp.wiki/payments-fraud/point-of-sale-pos-systems/toast/pos-nation
- Loyverse pricing: https://loyverse.com/pricing ; offline: https://help.loyverse.com/help/offline-work-of-pos
- Loyverse review aggregation: https://www.rfp.wiki/payments-fraud/point-of-sale-pos-systems/loyverse/ncr-voyix-aloha-cloud
- StoreHub pricing (PH): https://www.storehub.com/ph/pricing/
- StoreHub BIR quick-start (Jul 2026): https://care.storehub.com/en/articles/13223804-ph-storehub-bir-compliance-updates-quick-start-guide
- StoreHub MEMC: https://care.storehub.com/en/articles/12252232-ph-how-to-set-up-and-apply-memc-discounts-for-senior-citizens-and-pwds
- StoreHub vs Loyverse / UTAK / Mosaic (competitor claims): https://www.storehub.com/ph/blog/storehub-vs-loyverse ; https://www.storehub.com/ph/blog/storehub-vs-utak ; https://www.storehub.com/ph/blog/storehub-vs-mosaic-which-pos-is-better-for-your-fb-business
- Mosaic POS: https://www.mosaic-solutions.com/?p=3040
- UTAK job post (BIR permit processing): https://www.kalibrr.com/id-ID/c/utak/jobs/240963/compliance-lead
- Qashier PH BIR help: https://support.qashier.com/en/articles/14815420-philippine-bir-compliance-special-discounts-receipts-audit-reports
- Klikit PH POS roundup (vendor): https://klikit.io/uncategorized-en/best-pos-systems-in-the-philippines-for-2026-features-pricing-best-use-cases
- BIR Public Advisory 14 Sep 2026: https://assets.kpmg.com/content/dam/kpmgsites/ph/pdf/InTAX/2026/EIS-Public-Advisory-Sep-2026-redacted.pdf
- BIR RMO 24-2023 digest: https://bir-cdn.bir.gov.ph/local/pdf/RMO%20No.%2024-2023%20Digest%20FINAL.pdf
