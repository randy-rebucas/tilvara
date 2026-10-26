# Adding an extension

An extension adds the tools of one trade (pharmacy, hardware, …) on top of the retail base. A business switches it on in Subscription → Extensions when its plan allows it. The design is ADR-0026. This page is the checklist for building one. `<code>` stands for the extension's code (lower case, digits, underscores, e.g. `pharmacy`).

## 1. Manifest (`packages/validation/src/extensions.ts`)
- Add an entry to `EXTENSIONS`:
  - `code`;
  - `requires` (if it builds on another extension);
  - `permissions` (`<code>.<action>`);
  - `privileged` (codes that need two-step sign-in);
  - `support` (read codes for support sessions);
  - `roleTemplates` (roles it adds; their codes must be base codes or its own).
- `extensions.test.ts` checks the format.
- Validation schemas for its routes go next to it in `@1pos/validation`.

## 2. Migration (one generated, one hand-written, as usual)
- `INSERT INTO extensions (code, name, description)`.
- `INSERT INTO permissions (code, description)` for every code in the manifest. `auth.test.ts` compares them.
- The plans that include it:

  ```sql
  UPDATE plans SET extensions = extensions || '["<code>"]' WHERE code IN (…);
  ```
- Its own tables, with the full tenant-table rules (CLAUDE.md):
  - `tenant_id`, `UNIQUE(tenant_id, id)`, composite FKs to core rows;
  - ENABLE + FORCE RLS with the canonical policy;
  - grants for `onepos_app`;
  - `GRANT SELECT … TO onepos_worker` (or an `EXPORT_EXCLUDED_TABLES` entry);
  - append-only triggers for financial or evidence rows.
- **Never** add a required column to a core table. Extension data goes in its own table keyed to the core row.
- Personal data: rows in `docs/compliance/privacy/processing-register.md` and `retention-schedule.md`.

## 3. API (`apps/api/src/<code>/`)
- A Nest module imported in `AppModule`. Its controllers take `@RequiresExtension('<code>')`, which refuses writes while the extension is off; reads stay open. They also take the usual `@RequirePermissions`.
- Services call `assertExtension(db, '<code>')` inside the transaction where a write must not slip past a switch-off.
- Server hooks go in `SERVER_HOOKS` in `apps/api/src/extensions/registry.ts`:
  - `onEnable`: seed defaults, idempotently;
  - `disableBlockers`: open records that block switching off.
- **Core code** reaches the extension only through a hook or `assertExtension`. If a core flow needs a new hook (checkout, receipts, reports, webhooks, API scopes), add it to `ServerExtension` and record it in the ADR.
- Offline: never refuse an offline sale because of an extension. Flag it instead (`OFFLINE_FLAGS`).
- Every new `:id` route needs a case in the `isolation.test.ts` attack matrix. The new tables need fixture rows in its world (switch the extension on there).
- Run `pnpm --filter @1pos/api openapi`.

## 4. Admin (`apps/admin-web`)
- **Navigation:** `NAV_ITEMS` entry with `extension: '<code>'`, or a sub-tab inside an existing area.
- **Guide:**
  - a `GUIDE_SECTIONS` part whose `area` is that nav item (the part hides while the extension is off);
  - `TOPIC_BY_PATH` entries;
  - `guide.<id>.*` copy in EN and FIL.
- **Role editor:** a `PERMISSION_GROUPS` entry with `extension: '<code>'`, plus `perm.<code>.*` and `permGroup.*` copy.
- **Copy:** `ext.<code>.name` and `ext.<code>.desc` for the Extensions page.
- **BFF:** allow the new resource in the BFF allow-list (`src/app/api/v1/[...path]/route.ts`), narrowly.
- **Feature checks:** pages read `me.activeTenant.extensions` (`extensionOn`) for anything shown inside a base page.

## 5. Till (`apps/pos-desktop`)
- A `TABS` entry with `extension: '<code>'` and its guide part (`GUIDE_SECTIONS` with `extension`) in the counter's guide.
- Offline, the snapshot's `extensions` says what the till may show.

## 6. Tests and docs
- **Integration:** switching it on, gating (403 `EXTENSION_NOT_ENABLED` when off), the plan allowance, the blockers, and isolation.
- **E2E:** a suite for its screens. Switch it on through the admin or the API in the script.
- **Docs:**
  - an ADR for the extension's own rules;
  - a CLAUDE.md line if it adds a rule others must follow;
  - the user guide;
  - STATUS, BACKLOG and LEFTOVER.
