---
version: 1
slug: "apps-admin-web"
primary_target: "apps/admin-web"
related_targets: []
---

# Surface brief — Tilvara admin web

Scope: `apps/admin-web` (all back-office routes). Mode: **Operate**.
Audience/job: PH SMB owners on laptops set up the business (entity → branch → register), manage team/roles, catalog & prices, and check subscription. Bilingual EN/FIL.
Constraints: every control functional or marked planned; read-only subscription state visible; invoicing disabled notice; money shown as ₱ with centavos from decimal strings.

## Direction contract

THESIS: Salapi — the admin reads like Philippine currency: denomination colours say what kind of thing you are looking at, serial figures say exactly which one. Refuses the grey-sidebar-plus-blue-button SaaS default.

OWN-WORLD: Note-paper ground #F4F1E8; ₱1000 blue #2A5DA8 header band with faint diagonal security lines; denomination colours as kinds — blue = catalog/prices, violet #6B4C9A = locations, orange #E07B1F = registers/terminals, green #1E5B3A = team, red #B8302E = destructive/errors only. White panels with a 1px inset double hairline (guilloche frame) and a right-edge denomination stripe. Archivo for UI, Archivo Narrow tracked caps + tabular numerals for IDs, SKUs, codes, money.

STORY: The owner sees where setup stands, what each count means, and the next action; IDs and prices are unambiguous; nothing is hidden when access is read-only.

FIRST VIEWPORT: 64px blue band (logo, tab nav, business switcher, EN/FIL, user). Page title + context line. Four KPI "notes" (products, branches, registers, team) each with denomination stripe and a serial sub-line. Left: table of recent price changes. Right 340px: subscription note, finish-setup checklist with primary blue action.

FORM: Philippine peso banknote series; position 1 on my ordered list (Impeccable's pick, chosen by the user over the rolled #4 Route Board); seed key 565bea88.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Signature move
Denomination stripe + serial line: every record panel carries its kind's colour stripe on the right edge and a tracked tabular "serial" line (code, SKU, count) — kind and identity readable without reading the title.

## Open decisions
- Final logo/brand (none exists; this direction is provisional per PRODUCT.md).
