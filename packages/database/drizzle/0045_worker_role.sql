-- Hand-written: least-privilege worker role (Phase 6 slice 2, ADR-0016).
-- The role is cluster-level, so it is created outside migrations (init/01-roles.sql for new volumes,
-- infra/docker/postgres/upgrade/2026-10-17-worker-role.sql for existing ones). Fail loudly when it
-- is missing rather than silently granting nothing.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onepos_worker') THEN
    RAISE EXCEPTION 'role onepos_worker is missing: run infra/docker/postgres/upgrade/2026-10-17-worker-role.sql as a superuser first';
  END IF;
END $$;

-- The outbox and the idempotency purge belong to the worker, no longer to the API's runtime role.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'outbox_claim(text, int, int)',
    'outbox_complete(uuid, text)',
    'outbox_fail(uuid, text, text, int)',
    'platform_purge_expired_idempotency()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM onepos_app', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_worker', f);
  END LOOP;
END $$;

-- What today's handlers read, read-only and under RLS (handlers run inside withTenant).
-- Each new handler that needs more gets an explicit grant here, never a blanket one.
GRANT SELECT (id, slug, name) ON tenants TO onepos_worker;            -- tenant name in messages
GRANT SELECT (id, tenant_id, user_id, status) ON tenant_memberships TO onepos_worker; -- users RLS policy
GRANT SELECT (id, email, display_name, status) ON users TO onepos_worker; -- tenant.onboarded welcome email
