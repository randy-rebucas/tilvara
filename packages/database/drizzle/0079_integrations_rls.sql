-- Hand-written: API keys and webhooks (session 20, ADR-0019).
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_keys USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON webhook_endpoints USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON webhook_deliveries USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint

-- The runtime role never reads a key's hash; it is checked by auth_api_key() below.
GRANT SELECT (id, tenant_id, name, prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by) ON api_keys TO onepos_app;--> statement-breakpoint
GRANT INSERT ON api_keys TO onepos_app;--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by) ON api_keys TO onepos_app;--> statement-breakpoint
GRANT SELECT, INSERT ON webhook_endpoints TO onepos_app;--> statement-breakpoint
GRANT UPDATE (url, description, topics, enabled, signing_salt, updated_at) ON webhook_endpoints TO onepos_app;--> statement-breakpoint
-- The API writes a test ping and sends a DEAD delivery again; everything else is the worker's (functions below).
GRANT SELECT, INSERT ON webhook_deliveries TO onepos_app;--> statement-breakpoint
GRANT UPDATE (status, attempts, available_at, last_error) ON webhook_deliveries TO onepos_app;--> statement-breakpoint
GRANT SELECT (id, tenant_id, name, prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by) ON api_keys TO onepos_readonly;--> statement-breakpoint
GRANT SELECT ON webhook_endpoints, webhook_deliveries TO onepos_readonly;--> statement-breakpoint
-- Data export: everything but the key hash and the signing salt (EXPORT_SECRET_COLUMNS); deliveries are a queue (excluded).
GRANT SELECT (id, tenant_id, name, prefix, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by) ON api_keys TO onepos_worker;--> statement-breakpoint
GRANT SELECT (id, tenant_id, url, description, topics, enabled, created_by, created_at, updated_at) ON webhook_endpoints TO onepos_worker;--> statement-breakpoint

-- A revoked key stays revoked; a key is never deleted (the audit log names it).
CREATE OR REPLACE FUNCTION app_api_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'api_keys rows are never deleted; revoke instead' USING ERRCODE = 'P0001';
  END IF;
  -- Only the last use moves freely (auth_api_key); a key is revoked once and nothing else changes.
  IF (to_jsonb(NEW) - ARRAY['revoked_at','revoked_by','last_used_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at','revoked_by','last_used_at'])
     OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by)) THEN
    RAISE EXCEPTION 'an API key is only revoked, once' USING ERRCODE = '23514', CONSTRAINT = 'api_keys_transition';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER api_keys_guard BEFORE UPDATE OR DELETE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION app_api_key_guard();--> statement-breakpoint

-- What the definer functions below touch, as the platform role (BYPASSRLS; each function names its rows).
GRANT SELECT, UPDATE (last_used_at) ON api_keys TO onepos_platform;--> statement-breakpoint
GRANT SELECT ON webhook_endpoints TO onepos_platform;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO onepos_platform;--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint

-- Resolve an API key (prefix + SHA-256 of the whole key): the business, its scopes and who made it.
-- Expired, revoked or wrong keys answer nothing. Notes the last use at most once a minute.
CREATE FUNCTION auth_api_key(p_prefix text, p_key_hash text)
  RETURNS TABLE (key_id uuid, tenant_id uuid, name text, scopes text[], created_by uuid, tenant_status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE api_keys k SET last_used_at = now()
   WHERE k.prefix = p_prefix AND k.key_hash = p_key_hash AND k.revoked_at IS NULL
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute');
  RETURN QUERY
    SELECT k.id, k.tenant_id, k.name, k.scopes, k.created_by, t.status
      FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
     WHERE k.prefix = p_prefix AND k.key_hash = p_key_hash AND k.revoked_at IS NULL
       AND (k.expires_at IS NULL OR k.expires_at > now());
END $$;--> statement-breakpoint
ALTER FUNCTION auth_api_key(text, text) OWNER TO onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_api_key(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_api_key(text, text) TO onepos_app;--> statement-breakpoint

-- Fan an outbox event out to the business's enabled endpoints that listen for its topic (once each).
CREATE FUNCTION webhook_enqueue(p_event_id uuid) RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ins AS (
    INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, topic, payload)
    SELECT e.tenant_id, w.id, e.id, e.topic, e.payload
      FROM outbox_events e JOIN webhook_endpoints w ON w.tenant_id = e.tenant_id AND w.enabled AND e.topic = ANY (w.topics)
     WHERE e.id = p_event_id
    ON CONFLICT (endpoint_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;--> statement-breakpoint

-- Claim due deliveries (or ones whose lease ran out), with what the worker needs to send them.
CREATE FUNCTION webhook_claim(p_worker text, p_batch int, p_lease_seconds int)
  RETURNS TABLE (id uuid, tenant_id uuid, endpoint_id uuid, topic text, payload jsonb, attempts int, url text, signing_salt text, created_at timestamptz)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (
    UPDATE webhook_deliveries d
       SET status = 'DELIVERING', locked_by = p_worker, attempts = d.attempts + 1,
           locked_until = now() + make_interval(secs => p_lease_seconds)
     WHERE d.id IN (
       SELECT x.id FROM webhook_deliveries x
        WHERE (x.status = 'PENDING' AND x.available_at <= now())
           OR (x.status = 'DELIVERING' AND x.locked_until < now())
        ORDER BY x.available_at
        LIMIT least(greatest(p_batch, 1), 200)
        FOR UPDATE SKIP LOCKED)
    RETURNING d.id, d.tenant_id, d.endpoint_id, d.topic, d.payload, d.attempts, d.created_at)
  SELECT c.id, c.tenant_id, c.endpoint_id, c.topic, c.payload, c.attempts, w.url, w.signing_salt, c.created_at
    FROM c JOIN webhook_endpoints w ON w.id = c.endpoint_id
$$;--> statement-breakpoint

-- Only the worker holding the lease settles a delivery: delivered, or back to PENDING after a pause, DEAD at the last attempt.
CREATE FUNCTION webhook_settle(p_id uuid, p_worker text, p_ok boolean, p_status_code int, p_error text, p_retry_in_seconds int) RETURNS text
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE webhook_deliveries
     SET status = CASE WHEN p_ok THEN 'DELIVERED' WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
         delivered_at = CASE WHEN p_ok THEN now() END,
         available_at = CASE WHEN p_ok THEN available_at ELSE now() + make_interval(secs => greatest(p_retry_in_seconds, 0)) END,
         locked_by = NULL, locked_until = NULL,
         last_status_code = p_status_code, last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
   WHERE id = p_id AND status = 'DELIVERING' AND locked_by = p_worker
  RETURNING status
$$;--> statement-breakpoint

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['webhook_enqueue(uuid)', 'webhook_claim(text, int, int)', 'webhook_settle(uuid, text, boolean, int, text, int)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_worker', f);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
