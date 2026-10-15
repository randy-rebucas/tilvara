-- Hand-written: idempotency + outbox RLS/grants and the worker's narrow claim/complete/fail
-- functions. Workers never get BYPASSRLS: they see only the rows these functions return, then
-- process each event inside withTenant(event.tenant_id).

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_records
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON idempotency_records TO onepos_app;
GRANT UPDATE (response_status, response_body) ON idempotency_records TO onepos_app;

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox_events
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE TRIGGER outbox_events_no_delete BEFORE DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
GRANT SELECT, INSERT ON outbox_events TO onepos_app;
GRANT SELECT ON outbox_events TO onepos_readonly;

GRANT SELECT, UPDATE ON outbox_events TO onepos_platform;
GRANT SELECT, DELETE ON idempotency_records TO onepos_platform;

-- Claim due events (and events whose lease expired because a worker died).
CREATE FUNCTION outbox_claim(p_worker text, p_batch int, p_lease_seconds int)
  RETURNS TABLE (id uuid, tenant_id uuid, topic text, payload jsonb, attempts int, correlation_id text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE outbox_events e
     SET status = 'PROCESSING', locked_by = p_worker, attempts = e.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds)
   WHERE e.id IN (
     SELECT o.id FROM outbox_events o
      WHERE (o.status = 'PENDING' AND o.available_at <= now())
         OR (o.status = 'PROCESSING' AND o.locked_until < now())
      ORDER BY o.available_at
      LIMIT least(greatest(p_batch, 1), 500)
      FOR UPDATE SKIP LOCKED)
  RETURNING e.id, e.tenant_id, e.topic, e.payload, e.attempts, e.correlation_id
$$;

-- Only the worker holding the lease may complete/fail an event.
CREATE FUNCTION outbox_complete(p_id uuid, p_worker text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE outbox_events SET status = 'DONE', processed_at = now(), locked_until = NULL, last_error = NULL
     WHERE id = p_id AND status = 'PROCESSING' AND locked_by = p_worker
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

CREATE FUNCTION outbox_fail(p_id uuid, p_worker text, p_error text, p_retry_in_seconds int) RETURNS text
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE outbox_events
     SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
         available_at = now() + make_interval(secs => greatest(p_retry_in_seconds, 0)),
         locked_until = NULL,
         last_error = left(p_error, 1000)
   WHERE id = p_id AND status = 'PROCESSING' AND locked_by = p_worker
  RETURNING status
$$;

CREATE FUNCTION platform_purge_expired_idempotency() RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH d AS (DELETE FROM idempotency_records WHERE expires_at < now() RETURNING 1)
  SELECT count(*)::int FROM d
$$;

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'outbox_claim(text, int, int)',
    'outbox_complete(uuid, text)',
    'outbox_fail(uuid, text, text, int)',
    'platform_purge_expired_idempotency()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    -- TODO(Phase 6): move to a dedicated onepos_worker login role.
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_app', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
