-- Run once as onepos_owner on a dev volume created before 2026-10-27 (migration 0126).
-- onepos_readonly is unused; as a login it could switch `app.tenant_id` itself and read any business.
ALTER ROLE onepos_readonly NOLOGIN;
