-- Hand-written: backups and restore drills (Phase 6 slice 4, ADR-0016).
-- * onepos_backup: the login that dumps the database. It is cluster-level, so it is created outside
--   migrations (init/01-roles.sql for new volumes, infra/docker/postgres/upgrade/2026-10-17-backup-role.sql
--   for existing ones). It reads everything (pg_read_all_data + BYPASSRLS: a dump must see every
--   tenant) and writes only through platform_record_backup().
-- * backup_runs: platform table, append-only, reached only through these functions.
-- * platform_metrics(): + the time of the last backup and of the last passed restore drill.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onepos_backup') THEN
    RAISE EXCEPTION 'role onepos_backup is missing: run infra/docker/postgres/upgrade/2026-10-17-backup-role.sql as a superuser first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_runs FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON backup_runs TO onepos_platform;
CREATE TRIGGER backup_runs_append_only BEFORE UPDATE OR DELETE ON backup_runs
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
--> statement-breakpoint
-- One successful backup (kind BACKUP) or one passed restore drill of a named backup (RESTORE_DRILL).
-- Failures are not recorded here: a failed run exits non-zero, and the age gauges alert when no
-- success arrives in time.
CREATE FUNCTION platform_record_backup(p_kind text, p_started_at timestamptz, p_file text, p_size bigint,
                                       p_sha256 text, p_migrations int, p_detail jsonb)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO backup_runs (kind, started_at, backup_file, size_bytes, sha256, migrations, detail)
  VALUES (p_kind, p_started_at, p_file, p_size, lower(p_sha256), p_migrations, coalesce(p_detail, '{}'::jsonb))
  RETURNING id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform_metrics()
  RETURNS TABLE (metric text, label text, value double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT 'outbox_events', s, (SELECT count(*) FROM outbox_events o WHERE o.status = s)::float8
    FROM unnest(ARRAY['PENDING', 'PROCESSING', 'DEAD']) AS s
  UNION ALL
  SELECT 'outbox_oldest_undelivered_age_seconds', '', coalesce(extract(epoch FROM now() - min(o.created_at)), 0)::float8
    FROM outbox_events o WHERE o.status IN ('PENDING', 'PROCESSING')
  UNION ALL
  SELECT 'payment_intents_unresolved', s, (SELECT count(*) FROM payment_intents p WHERE p.status = s)::float8
    FROM unnest(ARRAY['PROCESSING', 'UNKNOWN']) AS s
  UNION ALL
  SELECT 'payment_intents_unresolved_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(p.created_at)), 0)::float8
    FROM payment_intents p WHERE p.status IN ('PROCESSING', 'UNKNOWN')
  UNION ALL
  SELECT 'offline_sales_quarantined', '', count(*)::float8 FROM terminal_transactions x WHERE x.status = 'QUARANTINED'
  UNION ALL
  SELECT 'offline_sales_quarantined_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(x.received_at)), 0)::float8
    FROM terminal_transactions x WHERE x.status = 'QUARANTINED'
  UNION ALL
  -- Same rule as GET /v1/sync/terminals (TILL_SILENCE_MINUTES = 30): a till whose register has an
  -- open shift and that has not been in touch since the later of its last contact and the opening.
  SELECT m, '', v FROM (
    SELECT count(*)::float8 AS open_tills,
           count(*) FILTER (WHERE now() - greatest(c.opened_at, l.contact) > interval '30 minutes')::float8 AS silent,
           coalesce(max(extract(epoch FROM now() - greatest(c.opened_at, l.contact)))
                      FILTER (WHERE now() - greatest(c.opened_at, l.contact) > interval '30 minutes'), 0)::float8 AS longest
      FROM terminals t
      JOIN cashier_sessions c ON c.tenant_id = t.tenant_id AND c.register_id = t.register_id AND c.status = 'OPEN'
      CROSS JOIN LATERAL (
        SELECT greatest(
          (SELECT max(s.as_of) FROM terminal_snapshots s WHERE s.tenant_id = t.tenant_id AND s.terminal_id = t.id),
          (SELECT max(x.received_at) FROM terminal_transactions x WHERE x.tenant_id = t.tenant_id AND x.terminal_id = t.id)) AS contact
      ) l
     WHERE t.revoked_at IS NULL
  ) tills
  CROSS JOIN LATERAL (VALUES ('tills_with_open_shift', tills.open_tills), ('tills_silent', tills.silent),
                             ('tills_longest_silence_seconds', tills.longest)) AS g(m, v)
  UNION ALL
  SELECT 'cashier_sessions_awaiting_approval', '', count(*)::float8 FROM cashier_sessions c WHERE c.status = 'CLOSED'
  UNION ALL
  SELECT 'cashier_sessions_awaiting_approval_oldest_age_seconds', '', coalesce(extract(epoch FROM now() - min(c.closed_at)), 0)::float8
    FROM cashier_sessions c WHERE c.status = 'CLOSED'
  UNION ALL
  SELECT 'workers_alive', '', count(*) FILTER (WHERE w.beat_at > now() - interval '60 seconds')::float8 FROM worker_heartbeats w
  UNION ALL
  -- No worker has ever beaten (or every one stopped): +Inf, so "older than N" alerts fire.
  SELECT 'worker_heartbeat_age_seconds', '', coalesce(extract(epoch FROM now() - max(w.beat_at))::float8, 'Infinity'::float8)
    FROM worker_heartbeats w
  UNION ALL
  -- Unix time of the last success; 0 when there was none, so "older than N" alerts fire.
  SELECT 'backup_last_success_timestamp_seconds', '', coalesce(extract(epoch FROM max(b.finished_at)), 0)::float8
    FROM backup_runs b WHERE b.kind = 'BACKUP'
  UNION ALL
  SELECT 'restore_drill_last_success_timestamp_seconds', '', coalesce(extract(epoch FROM max(b.finished_at)), 0)::float8
    FROM backup_runs b WHERE b.kind = 'RESTORE_DRILL'
$$;
--> statement-breakpoint
ALTER FUNCTION platform_record_backup(text, timestamptz, text, bigint, text, int, jsonb) OWNER TO onepos_platform;
REVOKE ALL ON FUNCTION platform_record_backup(text, timestamptz, text, bigint, text, int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_record_backup(text, timestamptz, text, bigint, text, int, jsonb) TO onepos_backup;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
