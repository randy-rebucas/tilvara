# Open items after the second full audit (2026-10-27, session 38)

What the second audit (STATUS session 38) left open, gathered in one place so it can be picked up later. Each item says
where it lives, what is known and what would close it. When an item is closed, mark it ✅ here and in
`docs/LEFTOVER.md`, and note it in `docs/STATUS.md`.

Nothing from sessions 37–38 is committed yet (`git status`): commit first, or know that these items sit on an
uncommitted tree.

## 1. Decisions needed (the user, the DPO or the tax adviser)

### 1.1 ⬜ Customer rights in a suspended or lapsed business: DPO to confirm
- **Now:** a read-only business (lapsed trial or subscription, or suspended) may still record a customer's consent
  withdrawal and an erasure; giving consent and every other customer write stay refused.
- **Where:** `apps/api/src/customers/customers.controller.ts` (`@AllowReadOnlyBusiness()` on `POST /customers/:id/consent`
  and `/:id/anonymise`), `customers.service.ts` (`allowReadOnlyBusiness: !input.marketingConsent` for consent, `true`
  for anonymise); test "a lapsed or suspended business still records a "stop" and an erasure, nothing else" in
  `apps/api/test/integration/customers.test.ts`.
- **To close:** the DPO confirms it matches the privacy pack (`docs/compliance/privacy/`), then add a line to the
  pack (data subject requests) and to CLAUDE.md's support-access rule, which lists the routes allowed in a read-only
  business. If the DPO says no, remove the two decorators and the option, and update the test.

### 1.2 ⬜ Tax registration "From a date" with no date: guard on the server too?
- **Now:** the admin form refuses it (`apps/admin-web/src/app/(app)/locations/entities/[id]/tax-form.tsx`). The API
  still reads a missing `effectiveFrom` as "now" (`apps/api/src/tax/tax-profiles.ts` `insertProfile`), so any other
  client that forgets the date changes VAT status at once, and tax-profile versions cannot be undone.
- **Options:** (a) leave it, since the admin is the only client; (b) a required `when: 'now' | 'date'` field, with
  `effectiveFrom` required for `date` (an API contract change: validation schema, OpenAPI, integration test).
- **Recommendation:** (b), small and closes the hole for good.

### 1.3 ⬜ Webhook payloads: confirm the reworded rule
- **Now:** CLAUDE.md says payloads carry "ids, document numbers and stock figures only, never personal data or free
  text". That matches what they carry: `stock.low` / `stock.below_zero` have `movementType`, `quantity`,
  `reorderPoint` (migration 0087); `sale.*` have `saleNumber` / `returnNumber`.
- **To close:** the user accepts the wording, or asks for the payloads to be trimmed to ids. Trimming needs a
  migration replacing the trigger function, and it changes what existing receivers get.

### 1.4 ⬜ SC/PWD versus a promotion (tax adviser, from session 26)
Still open in LEFTOVER session 26: today the statutory discount always wins on the line. Listed here only so it is
not forgotten; not part of this audit.

## 2. Not seen working yet (verification gaps)

### 2.1 ⬜ Desktop till build and E2E
- Not run in session 38. The till changes (locked cart, Close shift waiting, drawer, offline receipt) went through
  `apps/pos-desktop` and `packages/pos-offline`, which the desktop shell loads.
- **To close:** `cd apps/pos-desktop && pnpm tauri build --debug --no-bundle`, API with `RATE_LIMITS_ENABLED=false`,
  then `pnpm test:e2e:desktop [exe] [outDir] [apiUrl]` (CLAUDE.md, "Desktop till"). Look at the screenshots.

### 2.2 ⬜ The till's new screens on screen
Unit-tested only (`return-options.test.ts`, `drawer.test.ts`, `printing.test.ts`, `engine.test.ts`):
- the locked cart after an unanswered checkout and "Complete sale again"; the "an earlier version was recorded"
  notice (`pay.earlierRecorded`);
- Close shift waiting for offline sales, "Send now" (`close.offlineWaiting`);
- the reasons shown instead of Void / Return / Exchange (`history.voidOtherShift`, …);
- the offline receipt's Discount and "VAT 12%" rows;
- "Disconnect this terminal" confirmation.
- **To close:** add steps to `apps/pos-desktop/e2e/counter-controls.mjs` / `counter-extras.mjs` (an unanswered
  checkout can be staged with `PAYMENT_TIMEOUT_MS` or by cutting the API through the desktop E2E's proxy on :4399),
  take 1440 and 390 px screenshots.

### 2.3 ⬜ Cash drawer on real hardware
- `apps/pos-desktop/src/lib/drawer.ts` `openDrawerFor()` fires the ESC/POS kick (best effort, errors swallowed) after
  a cash sale, offline sale, cash refund and pay in/out. Not tried on a printer with a drawer.
- **To close:** a pilot till with an RJ11 drawer on the receipt printer; if the kick fails silently, show a hint
  ("open the drawer by hand") rather than nothing.

### 2.4 ⬜ Seen in earlier passes, still not on screen
- The offline review's `off.why.other` fallback: no reachable code produces it on the dev DB (LEFTOVER, Offline sales).
- The till's Close shift listing a supplier paid from its drawer (LEFTOVER, Purchasing).

### 2.5 ⬜ A fresh review of the fixes themselves
The 62 fixes were checked by tests (unit, 434 API integration, 33 database integration, 23 E2E suites) and
screenshots, but no read-only review read the new code afresh. Worth one pass before a pilot, especially:
- `apps/pos-desktop/src/components/Payment.tsx` and `Sell.tsx` (unknown outcome, key rotation, `earlier`);
- `apps/admin-web/src/app/(app)/inventory/sheets.tsx` (only edited lines sent, `sameDecimal`);
- `apps/api/src/purchasing/receiving.service.ts` `returnLots()` and migration 0121;
- `apps/api/src/inventory/inventory.service.ts` `lockCounting` (one open sheet, quick count refused);
- `apps/admin-web/src/lib/refusals.ts` (maps the API's exact English messages first: brittle if a message changes).
`/code-review` on the uncommitted diff is the quick way.

## 3. Known limits left on purpose (could be improved later)

| # | Item | Where | What would lift it |
|---|---|---|---|
| 3.1 | Admin refusals in words cover the codes met in this pass; other API refusals still show the API's English message to FIL readers. The Z-reading's `SHIFT_OPEN` and the categories' `HAS_ACTIVE_CHILDREN` messages are not mapped. | `apps/admin-web/src/lib/refusals.ts` | Map by code everywhere (not by message), add the missing codes, a unit test that every code the API throws has EN/FIL words. |
| 3.2 | After `IDEMPOTENCY_KEY_REUSED` the till finds the earlier sale by resending under a new key (the server answers `DUPLICATE_TRANSACTION` with it). | `Payment.tsx` | A `clientTransactionId` filter on `GET /v1/sales` (validation schema + OpenAPI) and a plain lookup. |
| 3.3 | `/me` lists permission codes at any scope, so a branch-scoped manager may still be offered a team action the API refuses for another branch (the refusal reads in words). | `apps/admin-web/src/lib/team-access.ts` | A per-member `manageable` flag from `GET /v1/members`. |
| 3.4 | A shift page lists at most 5,000 sales (25 pages of 200), then says so. | `shifts/[id]/page.tsx` | A paged list with "Show more". |
| 3.5 | The journal shows the newest 500 entries, then says to narrow the dates. | `accounting.service.ts`, `books/page.tsx` | Cursor paging. |
| 3.6 | The import preview's English row errors (API messages); warnings are in words. | `product-import.service.ts`, `import-products.tsx` | Words per error code (`pio.err.<CODE>`), EN/FIL. |
| 3.7 | A drawer pays supplier invoices of its own branch only (`DRAWER_OTHER_BRANCH`). | payables | By design: each branch's books stay balanced. |

## 4. Kept on purpose (do not "fix")
- `api_keys_scopes_check` still allows `lodging.read`, `laundry.read`, `appointments.read` (migration 0119): an old key
  holding one must still record its last use and be revoked. Validation refuses them for new keys. To drop them:
  revoke such keys first, then tighten the check in a new migration.
- The removed trades' history: old service charges, retired tenders (ROOM_CHARGE, JOB_DEPOSIT) on old sales, retired
  journal sources "(retired)", the envelope's retired fields (→ `VALIDATION_FAILED`), audit entries with their codes,
  the 8 businesses' own "Pharmacist" roles, owners' own service items. See `docs/LEFTOVER.md`, "Retail fit audit,
  per area".
- The English fallbacks 'Staff' (`returns.service.ts`) and 'Cashier' (`sales.service.ts`) on receipts: only when a
  user row is missing, which cannot happen (users are never deleted); receipts stay English.

## Suggested order
1. Commit sessions 37–38 (after reading the diff).
2. 2.5 (a review of the fixes) and 2.1/2.2 (desktop build and the till's new screens), before any pilot.
3. 1.2 option (b) — small and closes a tax hole.
4. 1.1 and 1.3 when the DPO / user answers.
5. Section 3 as time allows (3.1 and 3.6 first: Filipino readers still meet English there).
