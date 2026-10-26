---
name: retail-fit-audit
description: Audit one Tilvara area at a time (an admin section with its sub pages, or the till) for anything that does not fit a retail shop after the removal of restaurants, lodging, laundry, salons, pharmacies and groceries, then fix what the user approves and verify it in the real app. Use when the user says "next <area>", "audit <area>", or asks to continue the retail fit audit.
---

# Retail fit audit, one area at a time

Since 2026-10-25 Tilvara is retail only (migrations 0110–0113; industries come back as extensions, ADR-0026).
Leftovers of the removed trades still surface in screens, copy, data and books. The user walks the app area by
area; each area is audited, reported, fixed on approval, verified and documented before the next.

## Before the first area of a session
1. Read `docs/STATUS.md` (top + latest session), then the **"Retail fit audit, per area"** section of
   `docs/LEFTOVER.md`: it lists the areas done (✅), what was kept on purpose, and the open items. Never
   re-audit a ✅ area unless asked.
2. `git status --short`: earlier areas may be uncommitted. Mention it; commit only when asked.
3. Areas: the admin sections under `apps/admin-web/src/app/(app)/` (overview `page.tsx`, products, prices,
   inventory, purchasing, sales, shifts, customers, audit, help, plus done ones) and the till
   (`apps/pos-desktop`). "Also all sub pages" means every route folder under the section.

## Phase 1: audit (read-only, report, then stop)
Read; do not change anything. For the area:
- **Pages and components**: every `page.tsx`, forms, the shared chrome/tabs, client components it imports.
- **Copy**: EN and FIL keys in `apps/admin-web/src/i18n/messages.ts` (EN first half, FIL second; a key
  group like `rep.*`, `loc.*`), `src/i18n/titles.ts` examples, the guide part (`guide.<area>.*`,
  `src/lib/guide.ts`). Till copy: `apps/pos-desktop/src/i18n.tsx`.
- **API**: the controller/service behind the screens (`apps/api/src/<module>`), validation schemas
  (`packages/validation/src`), and protocol types (`packages/sync-protocol`).
- **Data on the dev DB** (read-only): what actually exists (statuses, codes, flags, accounts, roles, methods).
  `C=$(docker ps -qf name=onepos-postgres); docker exec -i $C psql -U onepos_owner -d onepos -AtF' | ' -c "<select>"`
  (`onepos_owner` bypasses RLS; never write with it).
- **Search for the removed trades**: `grep -i -E "tip|service.?charge|package|commission|room|folio|stay|laundry|job.?order|kitchen|table|restaurant|menu|modifier|prescri|pharma|salon|appointment|staff|deposit|guest|ROOM_CHARGE|JOB_DEPOSIT|business_type"`.

Classify what you find:
- **Retail misfit**: active feature, option, account or copy from a removed trade → propose removal.
- **History kept on purpose**: append-only evidence so old documents add up (old sale charges, retired
  tenders on old sales, retired journal sources labelled "(retired)", envelope fields that quarantine an old
  till's sale). Keep it; make sure it reads in words, not raw codes. CLAUDE.md lists the deliberate ones.
- **Bugs met on the way** (not retail): broken flows, missing guards, raw codes, untranslated text, tables that
  scroll sideways on a phone (`RecordTable` rule), wrong copy. Report them too; the user has wanted them fixed.

Before calling something reachable or a bug, trace it (who produces this code? can this state occur after
the other guards?). Say what was checked and what was not.

**Report** (then stop and ask): a short "What I checked" table, history kept on purpose, then numbered findings,
each with the file link, the concrete effect and the proposed fix. For anything that changes data in every
business (a migration), lay out the options and wait for the user's choice. End with "Should I fix …?".

## Phase 2: fix (after the user says proceed)
Follow CLAUDE.md. Patterns used so far:
- **Copy**: every new key in EN *and* FIL (`guide.test.ts` fails otherwise); a guide line that names screens
  must list them all. Shared labels go in a small helper in `src/lib/` (e.g. `tenders.ts` → `tenderLabel`),
  imported with **relative paths** in files that unit tests load (vitest has no `@/` alias).
- **Tables**: `RecordTable` with `stacked` (title/meta/figure); a row whose action opens a form (e.g.
  `ReasonAction`) is better as a list row so the form gets full width.
- **API guards**: a 409 with a clear code/message, plus an integration test next to the existing one.
- **Migrations**: `pnpm --filter @1pos/database exec drizzle-kit generate --custom --name=<name>`; header
  comment explaining why; `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` for every table read or written, `FORCE`
  after; append-only or protected tables need `DISABLE TRIGGER USER` / `ENABLE` around the statements (as in
  0113, 0116). Delete what was never used, archive what has history. Old migrations are never edited: adjust
  tests that compare against them instead.
- When a change makes a CLAUDE.md statement stale, update that line.

## Phase 3: verify
1. `pnpm typecheck`, `pnpm lint` (check the exit code: `pnpm lint *> $env:TEMP\lint.txt; $LASTEXITCODE`),
   unit tests of the touched packages (`pnpm --filter @1pos/admin-web test`, `@1pos/api test` includes the
   OpenAPI drift test: after an input-schema change run `pnpm build` then `pnpm --filter @1pos/api openapi`).
2. Integration: `pnpm --filter @1pos/api exec vitest run --config vitest.integration.config.ts <names>` for
   the suites of the area; after a migration or anything that posts to the books, the whole
   `pnpm --filter @1pos/api test:integration` (run in background, ~10 min) and `@1pos/database test:integration`.
3. **Migration on the dev DB**: record before-counts, `docker exec $C pg_dump -U onepos_owner -d onepos -Fc >
   C:/Users/corew/onepos-backups/onepos-pre<NNNN>-<date>.dump`, `pnpm build`, `pnpm db:migrate`, after-counts,
   FORCE RLS and triggers back on, then the traceability audit:
   `AUDIT_DATABASE_URL=<DRILL_ADMIN_URL with /onepos> pnpm --filter @1pos/api exec tsx test/dev-audit.ts`
   (violations must be `{}`).
4. **Real app**: the user may have servers on 4320/3320/3330: leave them alone. Start fresh ones in the
   background on spare ports:
   - API: `$env:API_PORT='4321'; $env:RATE_LIMITS_ENABLED='false'; $env:API_METRICS_PORT='0'; Set-Location apps/api; node --env-file=../../.env dist/main.js`
   - Admin (after `pnpm --filter @1pos/admin-web build`): `$env:ONEPOS_API_URL='http://127.0.0.1:4321/v1'; Set-Location apps/admin-web; npx next start -p 3321 -H 127.0.0.1`
   - Wait on `/v1/health/ready` and `/sign-in`, run the area's existing E2E suites (CLAUDE.md lists them, e.g.
     `node apps/admin-web/e2e/<suite>.mjs http://127.0.0.1:3321 <outDir> http://127.0.0.1:4321`), plus a
     scratch check in the session scratchpad that signs up its own business through the API and drives the
     admin with `apps/admin-web/e2e/cdp.mjs` (import repo files with `pathToFileURL`). Take screenshots and
     look at them (1440 and 390 px).
   - Stop the servers afterwards (`Get-NetTCPConnection -State Listen -LocalPort 4321,3321` → `Stop-Process`);
     their "failed, exit 255" notifications are expected.
5. If an existing E2E expected the old behaviour, update the test, say so, and tighten a check that only
   passed by accident.

Pitfalls met:
- `Serial` and some labels are CSS-uppercased: `innerText` returns capitals; compare case-insensitively.
- Scripts reading the DB as the migrator must `BEGIN; SELECT set_config('app.tenant_id', $1, true)` first
  (FORCE RLS) or they read nothing.
- An old business made by an earlier E2E run can be signed into with `PASSWORD` from
  `apps/pos-desktop/e2e/api.mjs` (find its owner's email with an `onepos_owner` select): useful for viewing
  history (e.g. retired tenders or accounts).
- Never edit dev-DB rows by hand to stage a case (it is refused, rightly); say what could not be seen.
- Python heredocs editing files: assert each replacement matched once; avoid `\U…` Windows paths in
  non-raw strings (use forward slashes).

## Phase 4: document and hand over
- `docs/LEFTOVER.md` "Retail fit audit, per area": a ✅ line for the area (what was fixed, what was kept on
  purpose) and ⬜ lines for anything left open; keep "⬜ Next areas to audit: the user's call." last.
- `docs/BACKLOG.md`: add the area to the "Retail fit audit, per area" line.
- `docs/STATUS.md`: extend the "Last updated" summary and add a bold paragraph for the area under the current
  session with what changed and **Verified:** (exact commands and counts; what was not run).
- Final message: what was fixed (plain words, for the owner), how it was verified, anything not seen, files
  uncommitted, then ask which area is next.
