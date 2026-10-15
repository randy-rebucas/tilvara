-- Runs once when the dev Postgres volume is first created.
-- Role model (see docs/architecture/ADR-0004-tenant-isolation.md):
--   onepos_migrator : owns schema objects, runs migrations. Never used by the running app.
--   onepos_app      : runtime role. NOT owner, NOBYPASSRLS -> Row-Level Security always applies.
--   onepos_readonly : reporting / support read access (still subject to RLS).
--   onepos_platform : NOLOGIN, BYPASSRLS; owner of audited cross-tenant SECURITY DEFINER functions.
-- Dev passwords only. Production credentials come from the secret manager.

CREATE ROLE onepos_migrator LOGIN PASSWORD 'onepos_migrator_dev' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE onepos_app      LOGIN PASSWORD 'onepos_app_dev'      NOSUPERUSER NOBYPASSRLS;
CREATE ROLE onepos_readonly LOGIN PASSWORD 'onepos_readonly_dev' NOSUPERUSER NOBYPASSRLS;
-- onepos_platform: cannot log in. Owns the few audited SECURITY DEFINER functions that must
-- act across tenants (e.g. platform_create_tenant). Only role with BYPASSRLS.
CREATE ROLE onepos_platform NOLOGIN NOSUPERUSER BYPASSRLS;
GRANT onepos_platform TO onepos_migrator;

ALTER DATABASE onepos OWNER TO onepos_migrator;
CREATE DATABASE onepos_test OWNER onepos_migrator;

\connect onepos
ALTER SCHEMA public OWNER TO onepos_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO onepos_app, onepos_readonly;

\connect onepos_test
ALTER SCHEMA public OWNER TO onepos_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO onepos_app, onepos_readonly;
