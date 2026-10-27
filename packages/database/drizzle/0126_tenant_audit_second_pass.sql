-- Hand-written: second tenant audit (2026-10-27).
-- * onepos_readonly could read every business: RLS keys on a setting the session sets itself. It now reads
--   the global catalogs only (permissions, plans, extensions, discount_schemes); the role is NOLOGIN
--   (infra/docker/postgres/init/01-roles.sql, upgrade/2026-10-27-readonly-nologin.sql).
-- * app_assert_row_tenant(): the costing trigger runs as the platform role BEFORE the policy checks the
--   row, so it refuses a row of another business than the one in context first.
-- * app_assert_acting_user(): definer functions that take a person's id answer the API only for the
--   signed-in person (`app.user_id`): auth_list_memberships, auth_account_closure_blockers (so also
--   auth_account_close), auth_mfa_admin_reset's actor, auth_create_handoff_session.
-- * data_exports: the API inserts a request only (status REQUESTED, no file); the file key is set by the
--   worker's definer functions.
-- * users.last_login_at: no longer readable by the API (a former employer could watch sign-ins elsewhere).
-- * webhook_enqueue: only the event being processed, of the business in context.
-- * auth_api_key: a key stops working while the person who made it is not an active member (or the
--   account is not active).
-- * Hand-off sessions (session 41) are bound to their business and to the session that made them:
--   auth_create_handoff_session, auth_rotate_session(…, tenant) refuses another business (and ends the
--   hand-off) and checks membership before rotating, auth_resolve_context refuses a bound session for
--   another business, auth_revoke_session and refresh-token reuse end the hand-offs made from that session.

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;

-- 1. Read-only role ----------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM onepos_readonly;
GRANT SELECT ON permissions, plans, extensions, discount_schemes TO onepos_readonly;

-- 2. Guards ------------------------------------------------------------------------------------------
CREATE FUNCTION app_assert_row_tenant(p_tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Migrations and back-fills run without a business in context as the migrator; runtime roles never do.
  IF p_tenant IS DISTINCT FROM app_current_tenant_id()
     AND (app_current_tenant_id() IS NOT NULL OR session_user IN ('onepos_app', 'onepos_worker')) THEN
    RAISE EXCEPTION 'row belongs to another business' USING ERRCODE = '42501', CONSTRAINT = 'row_tenant_mismatch';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app_assert_row_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assert_row_tenant(uuid) TO onepos_platform;

CREATE FUNCTION app_assert_acting_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Operators (support CLI, migrations) call these functions by email or id; the API only for its session.
  IF session_user = 'onepos_app' AND p_user IS DISTINCT FROM app_current_user_id() THEN
    RAISE EXCEPTION 'only for the signed-in person' USING ERRCODE = '42501', CONSTRAINT = 'acting_user_mismatch';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app_assert_acting_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_assert_acting_user(uuid) TO onepos_platform;

-- As 0087, guarded by app_assert_row_tenant.
CREATE OR REPLACE FUNCTION app_cost_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  b stock_balances%ROWTYPE;
  q_after numeric;
  v_after numeric;
  avg_after numeric;
  counted numeric;
  expected numeric;
  rp numeric;
  policy text;
  alerts boolean;
  o record;
  out_value numeric;
BEGIN
  -- A row for another business than the one in context is refused before anything is read or written as
  -- the platform role (session 2026-10-27): RLS checks the row only after this BEFORE trigger has run.
  PERFORM app_assert_row_tenant(NEW.tenant_id);
  -- Pack openings (ADR-0020): each movement is the opening's packs out or pieces in, once.
  IF NEW.type IN ('UNPACK_OUT', 'UNPACK_IN') THEN
    SELECT p.branch_id, p.packs, p.pieces, c.pack_variant_id, c.piece_variant_id INTO o
      FROM pack_openings p JOIN pack_conversions c ON c.tenant_id = p.tenant_id AND c.id = p.conversion_id
     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.pack_opening_id;
    IF o.branch_id IS DISTINCT FROM NEW.branch_id
       OR (NEW.type = 'UNPACK_OUT' AND (NEW.variant_id <> o.pack_variant_id OR NEW.quantity <> -o.packs))
       OR (NEW.type = 'UNPACK_IN' AND (NEW.variant_id <> o.piece_variant_id OR NEW.quantity <> o.pieces))
       OR EXISTS (SELECT 1 FROM stock_movements m WHERE m.tenant_id = NEW.tenant_id AND m.pack_opening_id = NEW.pack_opening_id AND m.type = NEW.type) THEN
      RAISE EXCEPTION 'pack movement does not match its opening' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_pack_opening_match';
    END IF;
  END IF;

  INSERT INTO stock_balances (tenant_id, branch_id, variant_id, quantity, value, avg_cost, updated_at)
  VALUES (NEW.tenant_id, NEW.branch_id, NEW.variant_id, 0, 0, 0, now())
  ON CONFLICT (tenant_id, branch_id, variant_id) DO NOTHING;
  SELECT * INTO b FROM stock_balances
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id
   FOR UPDATE;

  IF NEW.type = 'COUNT' THEN
    SELECT l.counted_quantity, l.expected_quantity INTO counted, expected FROM stock_count_lines l
     WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.stock_count_line_id AND l.variant_id = NEW.variant_id;
    IF counted IS NULL THEN
      RAISE EXCEPTION 'count movement without its count line' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_count_link';
    END IF;
    -- From a count sheet: the difference against the frozen quantity; else set on hand to the count.
    NEW.quantity := counted - coalesce(expected, b.quantity);
    IF NEW.quantity = 0 THEN
      RETURN NULL; -- nothing to move
    END IF;
    NEW.unit_cost := NULL;
  END IF;
  q_after := b.quantity + NEW.quantity;

  IF NEW.quantity < 0 THEN
    NEW.unit_cost := b.avg_cost;
    NEW.value := CASE WHEN q_after = 0 THEN -b.value ELSE round(NEW.quantity * b.avg_cost, 4) END;
    v_after := b.value + NEW.value;
    avg_after := b.avg_cost;
    NEW.below_zero := q_after < 0;
  ELSE
    IF NEW.type = 'RETURN' THEN
      SELECT m.unit_cost INTO NEW.unit_cost FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.sale_line_id = NEW.sale_line_id AND m.type = 'SALE'
       ORDER BY m.created_at, m.id LIMIT 1;
    ELSIF NEW.type = 'TRANSFER_IN' THEN
      SELECT m.unit_cost INTO NEW.unit_cost FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.stock_transfer_line_id = NEW.stock_transfer_line_id AND m.type = 'TRANSFER_OUT';
    ELSIF NEW.type = 'UNPACK_IN' THEN
      -- The pieces carry what the packs took out (the packs leave first, in the same transaction).
      SELECT m.value INTO out_value FROM stock_movements m
       WHERE m.tenant_id = NEW.tenant_id AND m.pack_opening_id = NEW.pack_opening_id AND m.type = 'UNPACK_OUT';
      IF out_value IS NULL THEN
        RAISE EXCEPTION 'pieces from a pack that has not left stock' USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_pack_opening_match';
      END IF;
      NEW.unit_cost := round(-out_value / NEW.quantity, 4);
    ELSIF NEW.type = 'COUNT' THEN
      SELECT CASE WHEN b.avg_cost > 0 THEN b.avg_cost ELSE coalesce(v.reference_cost, 0) END INTO NEW.unit_cost
        FROM product_variants v WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.variant_id;
    END IF;
    IF NEW.unit_cost IS NULL THEN
      RAISE EXCEPTION 'inbound stock movement (%) needs a unit cost', NEW.type
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_unit_cost_required';
    END IF;
    IF NEW.type = 'UNPACK_IN' AND b.quantity >= 0 THEN
      -- Exactly the packs' value, so an opening moves no value in the books.
      v_after := b.value - out_value;
      avg_after := round(v_after / q_after, 4);
    ELSIF b.quantity > 0 THEN
      v_after := b.value + round(NEW.quantity * NEW.unit_cost, 4);
      avg_after := round(v_after / q_after, 4);
    ELSE
      avg_after := NEW.unit_cost;
      v_after := round(q_after * NEW.unit_cost, 4);
    END IF;
    NEW.value := v_after - b.value;
    NEW.below_zero := false;
  END IF;

  UPDATE stock_balances
     SET quantity = q_after, value = v_after, avg_cost = avg_after, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND branch_id = NEW.branch_id AND variant_id = NEW.variant_id;

  -- Alerts: only when going down, and only on the crossing, so a busy day mails once per item.
  IF NEW.quantity < 0 THEN
    SELECT s.negative_stock_policy, s.low_stock_alerts INTO policy, alerts FROM inventory_settings s
     WHERE s.tenant_id = NEW.tenant_id AND s.branch_id = NEW.branch_id;
    policy := coalesce(policy, 'ALLOW');
    alerts := coalesce(alerts, true);
    IF alerts THEN
      SELECT r.reorder_point INTO rp FROM reorder_points r
       WHERE r.tenant_id = NEW.tenant_id AND r.branch_id = NEW.branch_id AND r.variant_id = NEW.variant_id;
      IF rp IS NOT NULL AND b.quantity > rp AND q_after <= rp THEN
        INSERT INTO outbox_events (tenant_id, topic, payload)
        VALUES (NEW.tenant_id, 'stock.low', jsonb_build_object(
          'branchId', NEW.branch_id, 'variantId', NEW.variant_id, 'movementType', NEW.type,
          'quantity', q_after::text, 'reorderPoint', rp::text));
      END IF;
    END IF;
    IF policy <> 'ALLOW' AND b.quantity >= 0 AND q_after < 0 THEN
      INSERT INTO outbox_events (tenant_id, topic, payload)
      VALUES (NEW.tenant_id, 'stock.below_zero', jsonb_build_object(
        'branchId', NEW.branch_id, 'variantId', NEW.variant_id, 'movementType', NEW.type,
        'quantity', q_after::text, 'saleId', NEW.sale_id));
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- As 0124, for the signed-in actor only.
CREATE OR REPLACE FUNCTION auth_mfa_admin_reset(p_target uuid, p_actor uuid, p_reason text, p_correlation_id text)
  RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := app_current_tenant_id();
BEGIN
  PERFORM app_assert_acting_user(p_actor);
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no business in context' USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_forbidden'; END IF;
  IF p_target = p_actor THEN
    RAISE EXCEPTION 'use a recovery code to reset your own two-step sign-in' USING ERRCODE = '22023', CONSTRAINT = 'mfa_reset_self';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_memberships m
      JOIN membership_roles mr ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
      JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
     WHERE m.tenant_id = v_tenant AND m.user_id = p_actor AND m.status = 'ACTIVE'
       AND mr.scope_type = 'TENANT' AND rp.permission_code = 'members.manage') THEN
    RAISE EXCEPTION 'only someone who manages the whole team can reset two-step sign-in' USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = v_tenant AND user_id = p_target AND status <> 'REMOVED') THEN
    RAISE EXCEPTION 'not a member of this business' USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_not_member';
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id <> v_tenant AND user_id = p_target AND status <> 'REMOVED') THEN
    RAISE EXCEPTION 'this person is also in another business; Tilvara support resets their two-step sign-in'
      USING ERRCODE = '42501', CONSTRAINT = 'mfa_reset_other_business';
  END IF;
  DELETE FROM user_mfa_recovery_codes WHERE user_id = p_target;
  DELETE FROM user_mfa_factors WHERE user_id = p_target;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'MFA_RESET' WHERE user_id = p_target AND revoked_at IS NULL;
  INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, correlation_id, metadata)
  VALUES (NULL, 'USER', p_actor, 'auth.mfa.reset', 'user', p_target::text, left(p_correlation_id, 200),
          jsonb_build_object('tenantId', v_tenant, 'reason', left(btrim(p_reason), 500)));
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION auth_list_memberships(p_user_id uuid)
  RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_slug text, tenant_name text, tenant_status text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM app_assert_acting_user(p_user_id);
  RETURN QUERY
    SELECT m.id, t.id, t.slug, t.name, t.status
      FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = p_user_id AND m.status = 'ACTIVE' AND t.status IN ('ACTIVE', 'SUSPENDED')
     ORDER BY t.name;
END $$;

CREATE OR REPLACE FUNCTION auth_account_closure_blockers(p_user uuid)
  RETURNS TABLE (kind text, name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM app_assert_acting_user(p_user);
  RETURN QUERY
    SELECT 'MEMBERSHIP'::text, t.name FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = p_user AND m.status <> 'REMOVED'
    UNION ALL
    SELECT 'STAFF'::text, NULL::text FROM platform_staff s WHERE s.user_id = p_user AND s.status = 'ACTIVE'
    ORDER BY 1, 2;
END $$;

-- 3. Data export requests ------------------------------------------------------------------------------
CREATE FUNCTION app_data_export_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'REQUESTED' OR NEW.file_key IS NOT NULL OR NEW.size_bytes IS NOT NULL OR NEW.sha256 IS NOT NULL
     OR NEW.row_counts IS NOT NULL OR NEW.expires_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.error IS NOT NULL THEN
    RAISE EXCEPTION 'a data export starts as a request' USING ERRCODE = '23514', CONSTRAINT = 'data_exports_request';
  END IF;
  NEW.requested_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER data_exports_request BEFORE INSERT ON data_exports
  FOR EACH ROW EXECUTE FUNCTION app_data_export_request();

-- 4. Users -------------------------------------------------------------------------------------------
REVOKE SELECT (last_login_at) ON users FROM onepos_app;

-- 5. Webhooks and API keys ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webhook_enqueue(p_event_id uuid) RETURNS int
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ins AS (
    INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, topic, payload)
    SELECT e.tenant_id, w.id, e.id, e.topic, e.payload
      FROM outbox_events e JOIN webhook_endpoints w ON w.tenant_id = e.tenant_id AND w.enabled AND e.topic = ANY (w.topics)
     WHERE e.id = p_event_id AND e.tenant_id = app_current_tenant_id() AND e.status = 'PROCESSING'
    ON CONFLICT (endpoint_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
    RETURNING 1)
  SELECT count(*)::int FROM ins
$$;

CREATE OR REPLACE FUNCTION auth_api_key(p_prefix text, p_key_hash text)
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
       AND (k.expires_at IS NULL OR k.expires_at > now())
       AND EXISTS (SELECT 1 FROM tenant_memberships m JOIN users u ON u.id = m.user_id
                    WHERE m.tenant_id = k.tenant_id AND m.user_id = k.created_by AND m.status = 'ACTIVE' AND u.status = 'ACTIVE');
END $$;

-- 6. Hand-off sessions ---------------------------------------------------------------------------------
CREATE FUNCTION auth_create_handoff_session(p_parent_family uuid, p_user_id uuid, p_tenant_id uuid, p_token_hash text,
                                            p_expires_at timestamptz, p_user_agent text)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_family uuid := uuidv7();
  p user_sessions%ROWTYPE;
BEGIN
  PERFORM app_assert_acting_user(p_user_id);
  IF p_expires_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'a hand-off lasts minutes' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM user_sessions s
   WHERE s.family_id = p_parent_family AND s.user_id = p_user_id
     AND s.revoked_at IS NULL AND s.replaced_at IS NULL AND s.expires_at > now();
  IF NOT FOUND OR (p.bound_tenant_id IS NOT NULL AND p.bound_tenant_id <> p_tenant_id) THEN
    RAISE EXCEPTION 'no such session' USING ERRCODE = '42501', CONSTRAINT = 'handoff_forbidden';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
                  WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'ACTIVE' AND t.status IN ('ACTIVE', 'SUSPENDED')) THEN
    RAISE EXCEPTION 'not a member of this business' USING ERRCODE = '42501', CONSTRAINT = 'handoff_forbidden';
  END IF;
  INSERT INTO user_sessions (user_id, family_id, refresh_token_hash, expires_at, user_agent, mfa_verified_at, bound_tenant_id, parent_family_id)
  VALUES (p_user_id, v_family, p_token_hash, p_expires_at, left(p_user_agent, 300), p.mfa_verified_at, p_tenant_id, p_parent_family);
  RETURN v_family;
END $$;

DROP FUNCTION auth_rotate_session(text, text, timestamptz);
CREATE FUNCTION auth_rotate_session(p_old_hash text, p_new_hash text, p_new_expires timestamptz, p_tenant_id uuid)
  RETURNS TABLE (outcome text, user_id uuid, family_id uuid, active_tenant_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s user_sessions%ROWTYPE;
  v_tenant uuid := p_tenant_id;
BEGIN
  SELECT * INTO s FROM user_sessions WHERE refresh_token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NOT_FOUND'::text, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF s.revoked_at IS NOT NULL THEN
    RETURN QUERY SELECT 'REVOKED'::text, s.user_id, s.family_id, NULL::uuid; RETURN;
  END IF;
  IF s.replaced_at IS NOT NULL THEN
    UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'REFRESH_TOKEN_REUSE'
     WHERE (user_sessions.family_id = s.family_id OR user_sessions.parent_family_id = s.family_id) AND revoked_at IS NULL;
    INSERT INTO audit_logs (tenant_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
    VALUES (NULL, 'SYSTEM', s.user_id, 'auth.refresh_reuse', 'user', s.user_id::text,
            jsonb_build_object('sessionId', s.family_id));
    RETURN QUERY SELECT 'REUSED'::text, s.user_id, s.family_id, NULL::uuid; RETURN;
  END IF;
  IF s.expires_at <= now() THEN
    RETURN QUERY SELECT 'EXPIRED'::text, s.user_id, s.family_id, NULL::uuid; RETURN;
  END IF;
  IF s.bound_tenant_id IS NOT NULL THEN
    IF v_tenant IS NULL THEN
      v_tenant := s.bound_tenant_id;
    ELSIF v_tenant <> s.bound_tenant_id THEN
      -- A hand-off redeemed for another business: ended, as a reused code would be.
      UPDATE user_sessions SET revoked_at = now(), revoke_reason = 'BOUND_ELSEWHERE'
       WHERE user_sessions.family_id = s.family_id AND revoked_at IS NULL;
      RETURN QUERY SELECT 'BOUND_ELSEWHERE'::text, s.user_id, s.family_id, NULL::uuid; RETURN;
    END IF;
  END IF;
  -- Checked before rotating: a refresh for a business the person left keeps their session for the others.
  IF v_tenant IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.tenant_id = v_tenant AND m.user_id = s.user_id AND m.status = 'ACTIVE' AND t.status IN ('ACTIVE', 'SUSPENDED')) THEN
    RETURN QUERY SELECT 'NOT_A_MEMBER'::text, s.user_id, s.family_id, NULL::uuid; RETURN;
  END IF;
  UPDATE user_sessions SET replaced_at = now() WHERE id = s.id;
  INSERT INTO user_sessions (user_id, family_id, refresh_token_hash, expires_at, user_agent, mfa_verified_at, bound_tenant_id, parent_family_id)
  VALUES (s.user_id, s.family_id, p_new_hash, p_new_expires, s.user_agent, s.mfa_verified_at, s.bound_tenant_id, s.parent_family_id);
  RETURN QUERY SELECT 'ROTATED'::text, s.user_id, s.family_id, v_tenant;
END $$;

CREATE OR REPLACE FUNCTION auth_revoke_session(p_family_id uuid, p_user_id uuid, p_reason text)
  RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE user_sessions SET revoked_at = now(), revoke_reason = p_reason
   WHERE (family_id = p_family_id OR parent_family_id = p_family_id) AND user_id = p_user_id AND revoked_at IS NULL
$$;

CREATE OR REPLACE FUNCTION auth_resolve_context(p_user_id uuid, p_family_id uuid, p_tenant_id uuid)
  RETURNS TABLE (session_active boolean, user_active boolean, membership_id uuid, tenant_status text,
                 session_mfa boolean, mfa_enrolled boolean, privileged_since timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    EXISTS (SELECT 1 FROM user_sessions s
             WHERE s.family_id = p_family_id AND s.user_id = p_user_id
               AND s.revoked_at IS NULL AND s.replaced_at IS NULL AND s.expires_at > now()
               AND (s.bound_tenant_id IS NULL OR s.bound_tenant_id = p_tenant_id)),
    EXISTS (SELECT 1 FROM users u WHERE u.id = p_user_id AND u.status = 'ACTIVE'),
    (SELECT m.id FROM tenant_memberships m
      WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'ACTIVE'),
    (SELECT t.status FROM tenants t WHERE t.id = p_tenant_id),
    EXISTS (SELECT 1 FROM user_sessions s
             WHERE s.family_id = p_family_id AND s.user_id = p_user_id
               AND s.revoked_at IS NULL AND s.replaced_at IS NULL AND s.mfa_verified_at IS NOT NULL),
    EXISTS (SELECT 1 FROM user_mfa_factors f WHERE f.user_id = p_user_id AND f.confirmed_at IS NOT NULL),
    (SELECT u.privileged_since FROM users u WHERE u.id = p_user_id)
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_create_handoff_session(uuid, uuid, uuid, text, timestamptz, text)',
    'auth_rotate_session(text, text, timestamptz, uuid)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO onepos_platform', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO onepos_app', f);
  END LOOP;
END $$;

REVOKE CREATE ON SCHEMA public FROM onepos_platform;
