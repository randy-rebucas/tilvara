-- One-off for clusters created before Phase 6 slice 4 (fresh volumes get this from init/01-roles.sql).
-- Run once per cluster as a superuser, BEFORE migration 0052:
--   docker compose exec -T postgres psql -U onepos_owner -d postgres -v ON_ERROR_STOP=1 < infra/docker/postgres/upgrade/2026-10-17-backup-role.sql
-- In a managed database, create the role with a generated password from the secret manager instead
-- of the dev one below. It reads every row of every tenant: keep its password with the ops
-- credentials, never on an application host.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onepos_backup') THEN
    CREATE ROLE onepos_backup LOGIN PASSWORD 'onepos_backup_dev' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT pg_read_all_data TO onepos_backup;
