-- One-off for databases created before Phase 6 slice 2 (fresh volumes get this from
-- init/01-roles.sql). Run once per cluster as a superuser, BEFORE migration 0045:
--   docker compose exec -T postgres psql -U onepos_owner -d postgres -v ON_ERROR_STOP=1 < infra/docker/postgres/upgrade/2026-10-17-worker-role.sql
-- In a managed database, create the role with a generated password from the secret manager instead
-- of the dev one below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onepos_worker') THEN
    CREATE ROLE onepos_worker LOGIN PASSWORD 'onepos_worker_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

\connect onepos
GRANT USAGE ON SCHEMA public TO onepos_worker;

\connect onepos_test
GRANT USAGE ON SCHEMA public TO onepos_worker;
