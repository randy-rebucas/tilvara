# ADR-0004: Shared-schema multi-tenancy with forced Row-Level Security

- Status: Accepted (2026-10-15)

## Decision
1. Every tenant-owned table has `tenant_id uuid NOT NULL` and `UNIQUE (tenant_id, id)`; child tables reference parents with composite FKs `(tenant_id, parent_id) → parent(tenant_id, id)` so a row can never point at another tenant's row.
2. `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;` with policy `tenant_id = app_current_tenant_id()`, both `USING` and `WITH CHECK`.
3. `app_current_tenant_id()` reads `current_setting('app.tenant_id', true)`; unset → NULL → **no rows** (fail closed).
4. The API sets context **only** inside a transaction with `set_config('app.tenant_id', $1, true)` (transaction-local). When the transaction ends the setting disappears, so a pooled connection cannot leak context to the next request. Code outside `withTenant()` sees zero tenant rows.
5. Tenant id comes from the authenticated membership resolved server-side; request bodies/headers are never trusted for tenant scope.
6. Runtime role `onepos_app` is not the table owner and has `NOBYPASSRLS`. Platform-level operations (tenant provisioning, plan management) use explicitly named `SECURITY DEFINER` functions or a separate platform service path that is audited.
7. Support access: time-boxed, purpose-stated `support_access_grants` approved by the tenant owner; every support query is audited.

## Consequences
- RLS is defense in depth; application queries still filter by tenant and are tested adversarially (`test:integration` cross-tenant suite).
- Cross-tenant reports for the platform operator must go through a dedicated, audited path.
