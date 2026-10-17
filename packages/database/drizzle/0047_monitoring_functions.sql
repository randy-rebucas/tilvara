-- Hand-written: operational monitoring (Phase 6 slice 3, ADR-0016).
-- * platform_metrics(): business gauges for the API's internal metrics port. Counts and ages only,
--   across tenants, never a tenant's records, ids or names, so the metrics port cannot leak data.
-- * platform_migration_head(): the schema's migration head, for readiness.
-- * worker_heartbeat()/worker_heartbeat_stop(): one row per running outbox worker.
-- * outbox_dead_list()/outbox_dead_replay(): the DEAD-letter tool, each replay audited.

-- worker_heartbeats is a platform table: no tenant, no runtime grants; only these functions reach it.
ALTER TABLE worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_heartbeats FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeats TO onepos_platform;

-- What the gauges read (onepos_platform bypasses RLS but still needs table privileges).
GRANT SELECT ON payment_intents, terminal_transactions, terminal_snapshots, cashier_sessions TO onepos_platform;
GRANT SELECT (revoked_at) ON terminals TO onepos_platform;
GRANT USAGE ON SCHEMA drizzle TO onepos_platform;
GRANT SELECT ON drizzle.__drizzle_migrations TO onepos_platform;

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

-- Every row: a gauge name (exported as onepos_<metric>), at most one label value from a fixed set
-- (statuses), and a number. Ages are seconds by the DB clock; "none waiting" is an age of 0.
CREATE FUNCTION platform_metrics()
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
$$;

CREATE FUNCTION platform_migration_head()
  RETURNS TABLE (applied int, last_created_at bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int, max(m.created_at)::bigint FROM drizzle.__drizzle_migrations m
$$;

CREATE FUNCTION worker_heartbeat(p_worker text, p_started_at timestamptz, p_version text)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO worker_heartbeats (worker_id, started_at, beat_at, version)
  VALUES (left(p_worker, 100), p_started_at, now(), left(p_version, 50))
  ON CONFLICT (worker_id) DO UPDATE SET beat_at = now(), started_at = EXCLUDED.started_at, version = EXCLUDED.version;
  -- Workers that died without stopping are forgotten after a day.
  DELETE FROM worker_heartbeats WHERE beat_at < now() - interval '1 day';
$$;

CREATE FUNCTION worker_heartbeat_stop(p_worker text)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM worker_heartbeats WHERE worker_id = left(p_worker, 100);
$$;

-- DEAD rows without their payload (it may hold personal data); the error is already truncated.
CREATE FUNCTION outbox_dead_list(p_limit int, p_topic text)
  RETURNS TABLE (id uuid, tenant_id uuid, topic text, attempts int, last_error text, created_at timestamptz, failed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.id, o.tenant_id, o.topic, o.attempts, o.last_error, o.created_at, o.available_at
    FROM outbox_events o
   WHERE o.status = 'DEAD' AND (p_topic IS NULL OR o.topic = p_topic)
   ORDER BY o.created_at, o.id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;

-- Put one DEAD row back in the queue with a fresh set of attempts, and record who did it and why
-- (platform-level audit row: NULL tenant). False when the row is not DEAD (already replayed, or no such row).
CREATE FUNCTION outbox_dead_replay(p_id uuid, p_actor text, p_reason text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e outbox_events%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR length(btrim(p_actor)) = 0 THEN
    RAISE EXCEPTION 'who is replaying is required' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO e FROM outbox_events WHERE id = p_id AND status = 'DEAD' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE outbox_events
     SET status = 'PENDING', attempts = 0, available_at = now(), locked_until = NULL, locked_by = NULL
   WHERE id = p_id;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  VALUES (NULL, 'SYSTEM', NULL, 'platform.outbox.replay', 'outbox_event', p_id::text,
          jsonb_build_object('actor', left(btrim(p_actor), 100), 'reason', left(btrim(p_reason), 500), 'topic', e.topic,
                             'tenantId', e.tenant_id, 'attempts', e.attempts, 'lastError', left(e.last_error, 300)));
  RETURN true;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_metrics()',
    'platform_migration_head()',
    'worker_heartbeat(text, timestamptz, text)',
    'worker_heartbeat_stop(text)',
    'outbox_dead_list(int, text)',
    'outbox_dead_replay(uuid, text, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
-- The API exports the gauges and checks the head; the worker beats and runs the DEAD-letter tool.
GRANT EXECUTE ON FUNCTION platform_metrics(), platform_migration_head() TO onepos_app;
GRANT EXECUTE ON FUNCTION worker_heartbeat(text, timestamptz, text), worker_heartbeat_stop(text),
                          outbox_dead_list(int, text), outbox_dead_replay(uuid, text, text) TO onepos_worker;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
