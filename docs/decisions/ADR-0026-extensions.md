# ADR-0026: Extensions — retail as the base, industry modules switched on per business

- Status: Accepted (2026-10-26, session 35).
- Context: in sessions 17–31, industries (restaurant, salon, lodging, laundry, grocery, pharmacy) were added as values of `tenants.business_type`. Hard-coded checks such as `servesPharmacy(type)` were copied into the API, the admin and the till, and HYBRID combined some of them. Removing them took four migrations (0110–0113) and changes across the codebase.
- The user wants an industry (pharmacy first) to come back as an **extension** that can be added later and switched on, with retail as the base. They chose, each time the recommended option:
  - **built-in modules** in this repo, not plugins installed at runtime;
  - the **owner** switches an extension on, and the **plan** decides which extensions they may choose;
  - **any combination** of extensions (this replaces HYBRID);
  - this slice is the **framework only**, proven with a test-only extension.
- Builds on ADR-0004 (tenant isolation), ADR-0015 (offline), ADR-0016 (MFA, support access, data export) and ADR-0019 (API keys). The plan-feature precedent is `assertFeature` (session 21).

## Decision

### 1. Retail is the base; an extension only adds
- Every business has the retail base: catalog, sales, stock, packs and expiry lots, purchasing, books, customers and reports. `tenants.business_type` stays `RETAIL` and means "the base". It is not used to gate anything.
- An extension adds things on top: its own tables, routes, permissions, roles, admin areas, till screens and guide parts. It never changes what a business without it sees or can do.

### 2. Where an extension is declared
- **In code**, `@1pos/validation` `EXTENSIONS` holds one `ExtensionManifest` per extension:
  - `code`;
  - `requires` (the extensions it builds on);
  - `permissions` (`<code>.<action>`);
  - `privileged` (codes that need two-step sign-in);
  - `support` (read codes a support session may use);
  - `roleTemplates`.
- `PERMISSIONS` is the base codes (`CORE_PERMISSIONS`) followed by every extension's codes. `PRIVILEGED_PERMISSIONS` and `SUPPORT_PERMISSIONS` include the extensions' declared codes too.
- The API adds server hooks per extension in `apps/api/src/extensions/registry.ts`:
  - `onEnable(db, auth)`: seed defaults, in the switch's transaction;
  - `disableBlockers(db)`: open records that must be finished before the extension is switched off.
- **In the database** (migrations 0114–0115):
  - `extensions` is the global catalog (`code`, `name`, `description`, `active`), read-only to tenants.
  - `plans.extensions` lists the codes each plan allows.
  - `tenant_extensions` holds one row per extension a business ever switched on (`enabled`, who and when). It is a tenant table: RLS, never deleted, exported. The history is in the audit log.
- The first release of an extension ships its manifest and its migration together. The migration inserts the catalog row, its `permissions` rows and its plan allowance, plus its own tables.

### 3. Usable = on, active and on the plan
- `app_usable_extensions()` and `app_extension_usable(code)` (SECURITY INVOKER, under the tenant's RLS) answer whether an extension is usable. That needs all three:
  - the business switched it on;
  - the catalog still offers it;
  - the current plan allows it.
- After a downgrade, or when an extension is withdrawn from the catalog, it stays switched on but is not usable. Its records stay readable.

### 4. Switching (`tenant.manage`)
- **Routes:** `GET /v1/extensions` is the catalog as the business sees it: `enabled`, `allowedByPlan`, `usable`, `requires`, `missing`. `POST /v1/extensions/:code/enable|disable` go through `TenantService.mutate()` (write check, optional Idempotency-Key), one at a time per business (advisory lock).
- **Switching on** is refused in these cases:
  - 403 `ENTITLEMENT_REQUIRED` when the plan does not allow it;
  - 409 `EXTENSION_REQUIRES` (`missing`) when an extension it requires is off;
  - 404 for an unknown or withdrawn code.

  Otherwise it does the following, all in one transaction, and switching on again changes nothing:
  - upserts the state row;
  - adds the extension's role templates (`addRoleTemplates`, additive);
  - grants every one of its codes to the business's built-in Owner and Administrator roles;
  - runs `onEnable`;
  - writes the audit row `tenant.extension_enabled`;
  - emits the outbox event `extension.enabled`.
- **Switching off** is refused in these cases:
  - 409 `EXTENSION_REQUIRED_BY` (`dependents`) while an extension that requires it is on;
  - 409 `EXTENSION_IN_USE` (`blockers`) while `disableBlockers` reports open records.

  Otherwise it sets `enabled = false`, audits `tenant.extension_disabled` and emits `extension.disabled`. Records, roles and grants stay, so switching back on loses nothing.

### 5. Gating
- **`@RequiresExtension(code)`** goes on an extension's controller (or a single route). The global `ExtensionGuard`, after `AuthGuard`, refuses its **writes** with 403 `EXTENSION_NOT_ENABLED` (`{extension}`) unless the extension is usable. Reads stay open, as with plan features, so records made before switching off stay visible.
- **`assertExtension(db, code)`** is for the same check inside a transaction: an extension service, or core code with an extension branch (e.g. a pharmacy rule in `record()`).
- **Offline:**
  - The snapshot carries `extensions` (the usable codes at `asOf`). Switching an extension bumps the catalog version, so tills refresh.
  - `recordOffline` is never refused because of an extension. An extension that needs to mark such a sale adds an `OFFLINE_FLAGS` value.
- **The screens** read `/me` → `activeTenant.extensions` (usable codes):
  - **Admin:** `NavItem.extension` (shown with `offered()`), guide sections whose area has an extension (hidden when it is off, and `topicFor` sends its pages to Subscription), and `PermissionGroup.extension` in the role editor. The role editor shows an extension's group while the business has the extension or the role holds one of its codes, so saving never drops a grant it did not show.
  - **Till:** `TabDef.extension` (`tabsFor`) and `GuideSection.extension` (`guideSections`).
- **Admin page:** Subscription → Extensions lists the catalog and has Switch on / Switch off. With no extension in the catalog it says none are available yet.

### 6. Rules for an extension's code
- Its data lives in **its own tables**, linked to core rows by composite foreign keys. It never adds required columns to core tables.
- Core flows reach an extension only through `assertExtension` or a registry hook. Core code never checks an extension code directly.
- Each extension's own tables follow every tenant-table rule in CLAUDE.md: RLS, grants, the worker export grant, isolation fixtures, the processing register for personal data, `@RequiresExtension` on its routes, and EN/FIL copy.
- The step-by-step checklist is `docs/architecture/extensions.md`.

## Consequences
- An industry can come back without touching what other businesses see. Taking it out of the product means withdrawing it in the catalog (`active = false`), not a destructive migration.
- No extension ships yet. The mechanism is proven by the test-only `test_fixture` and `test_addon` extensions (`apps/api/test/integration/fixtures/extension-fixture.ts`): the catalog, the plan, requirements, blockers, gating, `/me`, the snapshot, isolation and idempotency.
- Not built yet: extension-specific webhook topics, API-key scopes, report pages and receipt lines. These hook points are added when the first extension needs them (LEFTOVER).
