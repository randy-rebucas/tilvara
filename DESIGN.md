---
name: Tilvara Admin
description: Back office for Philippine shops, styled like peso notes. Denomination colour shows what kind of record you're looking at; serial figures show which record it is.
colors:
  paper: "#f4f1e8"
  paper-deep: "#ebe6d6"
  note: "#ffffff"
  ink: "#1d1f24"
  muted: "#555962"
  hair: "#cfc9b8"
  hair-soft: "#e7e1d1"
  table-head: "#fbf9f3"
  blue: "#2a5da8"
  blue-deep: "#1f4885"
  blue-ink: "#dce6f5"
  violet: "#6b4c9a"
  orange: "#b85f12"
  orange-soft: "#e07b1f"
  green: "#1e5b3a"
  gold: "#85600c"
  gold-soft: "#d4a227"
  red: "#b8302e"
  amber-bg: "#fbf0dc"
  info-bg: "#e9eff8"
  info-border: "#c5d4ea"
  info-text: "#1f3b66"
  error-bg: "#fbeceb"
  error-border: "#efc8c6"
  warn-border: "#ead3a6"
  warn-text: "#6b4a12"
typography:
  display:
    fontFamily: "Peso Sign, Archivo, system-ui, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Peso Sign, Archivo, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  figure:
    fontFamily: "Peso Sign, Archivo, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
  title:
    fontFamily: "Peso Sign, Archivo, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Peso Sign, Archivo, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Peso Sign, Archivo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.4
  section-title:
    fontFamily: "Peso Sign, Archivo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.12em"
  serial:
    fontFamily: "Peso Sign, Archivo Narrow, Archivo, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.08em"
    fontFeature: "tnum"
  money:
    fontFamily: "Peso Sign, Archivo Narrow, Archivo, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.02em"
    fontFeature: "tnum"
rounded:
  cell: "2px"
  chip: "3px"
  tab: "4px"
  control: "5px"
  note: "6px"
spacing:
  hairline-gap: "3px"
  kpi-gap: "14px"
  panel-y: "16px"
  panel-x: "20px"
  section-gap: "20px"
  column-gap: "24px"
  gutter-phone: "16px"
  gutter: "28px"
  band-height: "64px"
  rail-width: "340px"
  page-max: "1440px"
components:
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.note}"
    rounded: "{rounded.control}"
    padding: "0 14.4px"
    height: "36px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.blue-deep}"
  button-secondary:
    backgroundColor: "{colors.note}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 14.4px"
    height: "36px"
  button-danger:
    backgroundColor: "{colors.note}"
    textColor: "{colors.red}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "32px"
  input:
    backgroundColor: "{colors.note}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 11.2px"
    height: "38.4px"
  note-panel:
    backgroundColor: "{colors.note}"
    textColor: "{colors.ink}"
    rounded: "{rounded.note}"
    padding: "16px 20px"
  band:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.note}"
    height: "64px"
  nav-tab:
    textColor: "{colors.blue-ink}"
    rounded: "{rounded.tab}"
    padding: "6px 12px"
  chip-default:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.note}"
    rounded: "{rounded.chip}"
    padding: "0 8px"
    height: "22.4px"
  tag:
    backgroundColor: "{colors.note}"
    textColor: "{colors.muted}"
    rounded: "{rounded.chip}"
    padding: "0 8px"
    height: "22.4px"
  callout-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info-text}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  callout-warn:
    backgroundColor: "{colors.amber-bg}"
    textColor: "{colors.warn-text}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  callout-error:
    backgroundColor: "{colors.error-bg}"
    textColor: "{colors.red}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
---

# Design System: Tilvara Admin

## Overview

**Creative North Star: "Salapi (Peso Notes)"**

The admin reads like Philippine currency. On a banknote, the colour tells you the denomination at a glance and the serial number tells you exactly which note you're holding. Here, a record's denomination colour shows what kind of record it is (catalog, location, register, team), and a tracked, tabular serial line shows which one it is (SKU, branch code, TIN, count). An owner should be able to tell what kind of record a panel holds, and which one, before reading its title.

The surface is warm note-paper. Records sit on it as pure white "notes". Each note has a faint inner frame (a double hairline, like the guilloche border on a banknote) and a coloured denomination stripe down its right edge. A ₱1000-blue band with faint diagonal security lines runs across the top of every page. Density suits laptop work: 15px body text, compact tables, and inline forms that keep a task on the page instead of moving it into a modal. The world deliberately rejects the grey-sidebar-plus-blue-button SaaS default.

This identity is **provisional**. Tilvara has no logo, brand colours or brand fonts yet (PRODUCT.md, confirmed 2026-10-15). Salapi is the visual world set in code, and a real brand may replace it. Until then, every new admin surface follows it.

**Key Characteristics:**
- Warm paper ground (`paper`) with pure white record notes (`note`). The two whites never trade places.
- Denomination colour always means the kind of record, and nothing else.
- Right-edge denomination stripe on each record panel.
- Serial line in tracked narrow caps with tabular numerals, placed below the title.
- Money in Archivo Narrow with tabular numerals, right-aligned, never wrapped.
- Blue band with diagonal security lines across the top.
- Inline disclosure forms. No modals.
- Bilingual EN/FIL. All copy comes from the message catalog.

## Colors

Warm, papery neutrals, with four banknote denominations that act as a closed vocabulary for kinds of record, plus red reserved for harm.

### Primary
- **₱1000 Note Blue** (`blue`): catalog, products, prices and price lists. Also used for the primary action, the header band, focus rings, the input caret, the selected price-list outline, and the status marks in a checklist ("done" ticks and the "next" marker). It is the system's single action colour.
- **Deep Note Blue** (`blue-deep`): hover state for primary buttons only.
- **Band Ink** (`blue-ink`): secondary text and inactive tabs on the blue band.

### Secondary
- **₱100 Violet** (`violet`): locations, meaning legal entities, branches, branch codes, and the entity and branch limit meters.

### Tertiary
- **₱20 Orange** (`orange-soft` for stripes and meter fills, `orange` when the colour must carry text): registers and terminals. The soft orange appears only as a stripe or fill. Text in this kind uses the darker value so it keeps its contrast.
- **₱200 Green** (`green`): team, meaning members, invitations, roles, and the seats meter.
- **₱500 Gold** (`gold-soft` for stripes, `gold` when the colour must carry text): goods, meaning suppliers, purchase orders, goods receipts, stock on hand, transfers and counts. Like orange, the soft value is only a stripe; codes and document numbers in this kind use the darker `gold`.
- **Serial Ink** (`ink` as a stripe): the books, meaning journal entries, the chart of accounts, the trial balance and periods. It is the ink every note's serial number is printed in: money records that are not goods get no banknote colour.
- **Alarm Red** (`red`): destructive actions (Revoke, danger buttons), validation errors, error callouts, revoked and read-only states, and a meter that has hit its limit. Red never marks a kind of record.

Restaurant records (Phase 4) add no new colour; they map to the existing kinds. Dining areas, tables and kitchen stations are places in a branch, so they are **violet**. Menu items, menus and modifier choices are catalog, so they are **blue**. Recipes and ingredients are goods, so they are **gold**. Orders, bills and kitchen tickets are operational and carry no stripe. Their states are worded tags, amber only when someone must act: ready to serve, billed and waiting for payment. One state has one word everywhere: a printed, unpaid bill is "To pay" / "Babayaran" on the floor tile, the order and the bill. The kitchen sees its own words: a fired item it has not started is "New" / "Bago" (the floor calls it "Sent").

### Neutral
- **Note Paper** (`paper`): the page ground behind everything.
- **Deep Paper** (`paper-deep`): hover fill for off-band toggles.
- **Note White** (`note`): panels, inputs, buttons, tags. Always pure white.
- **Ink** (`ink`): primary text.
- **Muted Ink** (`muted`): ledes, labels, serial lines, section titles, table headers.
- **Hairline** (`hair`) and **Soft Hairline** (`hair-soft`): outer note borders, input and button strokes, dashed checklist rules (`hair`). The inner guilloche frame and table row rules (`hair-soft`).
- **Table Head** (`table-head`): table header row fill.
- **Callout tints** (`info-*`, `amber-bg` / `warn-*`, `error-*`): banners for info (planned or disabled features), warnings (read-only access), and errors.

### Named Rules
**The Denomination Rule.** Each colour names exactly one kind of record: blue for catalog, prices and the primary action; violet for locations; orange for registers and terminals; green for team; gold for goods (stock, suppliers, purchasing); an ink stripe for the books; red only for destructive actions and errors. A colour never means anything else. Picking a colour for decoration or for variety breaks the system.

**The Blue Tick Rule.** Status marks (done ticks, "next" markers, selection) use blue, the action colour. They never use green. Green means team.

**The Two Whites Rule.** Panels are pure white (`note`) on warm paper (`paper`). Never tint a panel and never put white directly on white. The contrast between the two whites is what makes a record look like a note.

## Typography

**Display Font:** Archivo (with system-ui, sans-serif)
**Body Font:** Archivo
**Label/Mono Font:** Archivo Narrow, weights 500/600 (falls back to Archivo)

**Peso Sign glyph:** a `"Peso Sign"` `@font-face` with `unicode-range: U+20B1` maps only the ₱ character to a system face (Segoe UI, Roboto, SF Pro Text, Helvetica Neue, Noto Sans). Archivo's own ₱ has hairline bars that vanish at 13–15px and read as "P"; every other character stays Archivo. It is first in both font stacks (admin-web and pos-desktop).

**Character:** Archivo is a sturdy grotesque. It's legible at 15px and firm in bold headings. Archivo Narrow in tracked caps with tabular numerals is the "serial printing" on the note: it carries codes, counts and money, and it stays in its own register apart from the prose.

### Hierarchy
- **Display** (700, 2.25rem, 1.1, -0.015em): sign-in, sign-up and accept-invite headlines only.
- **Headline** (700, 1.75rem, tight, -0.01em): page titles (`PageHeader`). Each title is followed by a muted lede line, max 68ch.
- **Figure** (600, 1.75rem, line-height 1, tabular): KPI counts on overview notes. Also used for the plan name (700) on the subscription note.
- **Title** (600, 1.0625rem): note and panel titles such as "Finish setup", a branch name, a business name.
- **Body** (400, 15px, 1.5): everything else. Table cells are 0.875rem.
- **Label** (600, 0.8125rem): form labels and button text (0.875rem). Small muted mixed-case labels name KPI figures.
- **Section Title** (600, 0.8125rem, 0.12em tracking, uppercase, muted): `h2` headings for page sections ("Legal entities", "Plan limits"). They are the headings themselves, not decoration above some other heading.
- **Serial** (Archivo Narrow 500, 0.8125rem, 0.08em tracking, uppercase, tabular): SKUs, barcodes, TINs, branch, register and BIR codes, counts, permission totals, days left, the EN/FIL toggle.
- **Money** (Archivo Narrow 600, 0.02em tracking, tabular, nowrap): every peso amount, rendered as `₱` with centavos from the decimal string, right-aligned in tables.

### Named Rules
**The Serial Below Rule.** A serial line sits **below** the title it identifies (title, then serial). A tracked caps line is never placed above a heading. This system has no eyebrows or kickers.

**The Narrow Money Rule.** Money and identifiers are always set in Archivo Narrow with tabular numerals. Body Archivo never carries a price, and a price never wraps.

## Layout

A centred page up to 1440px wide, with a 28px gutter (16px on phones). The 64px blue band is sticky at the top. Below the `lg` breakpoint (1024px), the tabs drop to their own horizontally scrolling row under the logo line, and the right edge fades out so hidden tabs are still discoverable. Page content stacks with 20 to 24px gaps. Overview at `xl` (1280px) uses a main column plus a 340px right rail. Below `xl` the rail moves to the top, so the next action comes first. KPI notes sit in a 4-up grid at `lg` and 2-up below it, with a 14px gap. Paired sections (Registers and Terminals, Invitations and Roles) sit side by side on desktop. Auth pages use a 1040px grid, with the headline on the left and a 420px form note on the right.

Tables have a minimum width of 640px and scroll horizontally inside their note. **The Stacked Row Rule:** below `md` (768px), a table whose key figure (a price) would scroll off-screen becomes a stacked list. Each row shows the identity on the left and the money on the right, so the figure is always visible. `RecordTable` (`src/components/record-table.tsx`) does this for every inventory, purchasing and books table, including a totals row.

Sections with several pages (Inventory, Books) put **section tabs** under the page header: ink on paper with a 2px blue underline on the active tab (`SubNav`), never a second blue band. The branch or legal entity a page works on is chosen with a row of small notes (`ScopePicker`, the price-list picker pattern) and lives in the URL (`?branch=`, `?entity=`). Document pages (an order, a receipt, a transfer, a count, a journal entry) open with a muted back link, the document title with its serial number, a serial line, then a summary note of figures; each links to the journal entry it posted, and the entry links back to it.

Forms are inline. A "+ Add …" secondary button expands in place into a white bordered panel holding the fields, and it collapses on save or cancel. The task stays in the context of the list it changes.

## Elevation & Depth

The system is mostly flat paper, with one soft lift. Notes rest slightly above the paper on a warm, low two-layer shadow. Depth also comes from the double hairline frame, not from stacking surfaces. Clickable KPI notes deepen to a medium shadow on hover. Nothing else casts a shadow: buttons, inputs, callouts and the band are all flat.

### Shadow Vocabulary
- **Note rest** (`box-shadow: 0 1px 2px rgb(60 50 20 / 0.06), 0 4px 12px -6px rgb(60 50 20 / 0.12)`): every note panel.
- **Note hover** (`box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)`): linked KPI notes on hover only.

### Named Rules
**The Paper Lift Rule.** Shadows are warm-tinted (`rgb(60 50 20)`), low and soft. Only notes are lifted. Hard offset shadows and floating overlays are not part of this world.

## Shapes

Corners are slightly rounded, like trimmed banknote stock: notes 6px, buttons, inputs and callouts 5px, tabs and toggles 4px (the inner guilloche frame is also 4px, inset 4px), chips and tags 3px, meter cells 2px. Strokes are always 1px hairlines. The signature geometry is the 7px **denomination stripe**, clipped to the note's right corners. Plan-limit meters are drawn as one cell per allowed unit (capped at 40) with 3px gaps, so quantity reads as exact geometry rather than a percentage bar. Checklist rows are separated by dashed hairlines.

## Components

### Buttons
Restrained and solid: a white secondary button is the default, and blue is reserved for the single next action.
- **Shape:** gently rounded (5px), 36px tall, 600 weight at 0.875rem, a 6px icon gap, nowrap.
- **Primary:** Note Blue fill with white text. Used once per view, for the next action (for example "Price your products" or "Sign in"). It may be full width inside a rail note.
- **Secondary (default):** white with a hairline border and ink text. Opens disclosures with a leading `+` icon. Used for Archive.
- **Danger:** a secondary button with red text. On hover the border turns red over a faint red wash. Row actions use a compact 32px size.
- **Hover / Focus:** 120ms ease-out colour transitions. Secondary hover darkens the border to `#b6ae98`. Focus is a 2px blue outline with a 2px offset. Disabled is 55% opacity.

### Chips and Tags
- **Chip:** a solid denomination fill with white 600-weight 0.75rem text, 3px radius. Marks a property of the record (for example "Default" on a price list, in blue).
- **Tag:** white with a hairline border and muted 0.75rem 600-weight text. Used for neutral status (Active, Archived, Built-in). It switches to red text for Revoked or Read-only.

### Cards / Containers (Notes)
- **Corner Style:** 6px.
- **Background:** pure white on paper.
- **Shadow Strategy:** Note rest (see Elevation).
- **Border:** a 1px `hair` outer border, plus a 1px `hair-soft` inner frame inset 4px (the guilloche double hairline).
- **Denomination stripe:** a 7px right-edge bar in the record kind's colour. Omitted on neutral notes such as the setup checklist and plan limits.
- **Internal Padding:** 16 to 20px vertical, 20 to 24px horizontal. KPI notes add right padding so content clears the stripe.

### Inputs / Fields
- **Style:** white, 38px tall, 5px radius, hairline stroke, 0.9375rem text. The label sits above (0.8125rem, 600) and the hint below (0.8125rem, muted).
- **Focus:** a 2px blue outline, and the border turns blue. The caret is blue.
- **Error:** red border with `aria-invalid`, and the hint becomes the red error text. Form-level errors use the error callout with `role="alert"`.

### Navigation
The blue band carries the "Tilvara" wordmark (1.5rem, 700, 0.04em tracking), tabs, the EN/FIL toggle, and the business and user block. Inactive tabs are Band Ink. Hover is a 10% white wash. The active tab is a 18% white fill with white 600-weight text and `aria-current="page"`. Tabs only appear when the user's permissions allow them. The EN/FIL toggle is a serial-styled pair of `aria-pressed` buttons. Sign-out and switch-business are 32px icon buttons with screen-reader labels.

### Tables
Header row in uppercase 0.75rem, 0.06em tracking, muted, on `table-head`. Cells use 11 to 14px padding with soft-hairline row rules and no rule after the last row. Numeric columns are right-aligned. Identifier columns use serial type in ink.

### Callouts
Full-width 5px-radius banners with a 1px tinted border. Info is blue-tinted (for disabled BIR invoicing or planned billing). Warn is amber (for read-only access). Error is red-tinted. They state the plain truth without decoration. Info and warn use `role="status"`, and error uses `role="alert"`.

### Signature: Denomination Note + Serial Line
Every record panel carries its kind's colour on the right edge and a serial line under its title. For example, a branch note shows "Makati Main" with "MKT-01 · BIR 00000 · ENTITY NAME" beneath it, and the code is set in the kind's colour. A KPI note shows a muted label, the figure, then a serial sub-line ("PAIRED TERMINALS: 1").

### Motion
Page content reveals over 380ms (`cubic-bezier(0.16, 1, 0.3, 1)`), rising 4px from 40% opacity. This only runs when the user has not requested reduced motion. State transitions take 120ms ease-out.

## Do's and Don'ts

### Do:
- **Do** pick the stripe, chip and meter colour from the record's kind: blue for catalog and prices, violet for locations, orange for registers and terminals, green for team, gold for goods, an ink stripe for the books.
- **Do** print negative money with a true minus sign (`−₱23.00`), and sign variances explicitly (`+2`, `−2`) rather than by colour alone.
- **Do** put a serial line (code, SKU, TIN, count) directly **below** every record title, in Archivo Narrow tracked caps with tabular numerals.
- **Do** set every peso amount with the money style, `₱` and centavos from the decimal string, right-aligned and nowrap.
- **Do** keep panels pure white (`#ffffff`) on note paper (`#f4f1e8`), with the double hairline frame.
- **Do** use the blue band with diagonal security lines as the top of every page, auth pages included.
- **Do** add records with an inline disclosure panel that expands in place.
- **Do** turn a table into stacked rows below 768px whenever its key figure would scroll off-screen.
- **Do** route every string through the EN/FIL message catalog (`src/i18n/messages.ts`).
- **Do** use blue for status ticks, the "next" marker and selection.

### Don't:
- **Don't** use red for anything other than destructive actions, errors, revoked or read-only states, and exhausted limits.
- **Don't** use green for success or completion. Green means team.
- **Don't** put an uppercase tracked line (an eyebrow or kicker) above a heading. Section titles are themselves the `h2`.
- **Don't** open modals for create or edit flows.
- **Don't** hard-code UI copy in components, or ship a string in only one language.
- **Don't** tint panels or float them with hard or offset shadows.
- **Don't** fall back to a grey sidebar with a generic blue button.
- **Don't** treat Salapi as final brand. It is provisional until Tilvara has a real identity.
