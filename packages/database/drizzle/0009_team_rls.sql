-- Hand-written: invitation RLS/grants, invitation lookup for the accept flow, and a
-- deferred "a tenant always keeps an active owner" guard.

ALTER TABLE member_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON member_invitations
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE TRIGGER member_invitations_no_delete BEFORE DELETE ON member_invitations
  FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();

GRANT SELECT (id, tenant_id, email, roles, status, invited_by, expires_at, accepted_at, accepted_user_id, revoked_at, created_at)
  ON member_invitations TO onepos_app, onepos_readonly;
GRANT INSERT ON member_invitations TO onepos_app;
GRANT UPDATE (status, accepted_at, accepted_user_id, revoked_at) ON member_invitations TO onepos_app;

-- The invitee is not yet in the tenant, so finding the invitation by token is cross-tenant.
GRANT SELECT ON member_invitations TO onepos_platform;
CREATE FUNCTION auth_find_invitation(p_token_hash text)
  RETURNS TABLE (invitation_id uuid, tenant_id uuid, email text, status text, expires_at timestamptz, tenant_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.tenant_id, i.email, i.status, i.expires_at, t.name
    FROM member_invitations i JOIN tenants t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash
$$;

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;
ALTER FUNCTION auth_find_invitation(text) OWNER TO onepos_platform;
REVOKE CREATE ON SCHEMA public FROM onepos_platform;
REVOKE ALL ON FUNCTION auth_find_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_invitation(text) TO onepos_app;

-- Every tenant must keep at least one ACTIVE member holding the system owner role at TENANT
-- scope. Deferred to commit so "replace all roles" in one transaction is allowed.
CREATE FUNCTION app_assert_tenant_has_owner() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE v_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM membership_roles mr
      JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id AND r.key = 'owner' AND r.is_system
      JOIN tenant_memberships m ON m.tenant_id = mr.tenant_id AND m.id = mr.membership_id AND m.status = 'ACTIVE'
     WHERE mr.tenant_id = v_tenant AND mr.scope_type = 'TENANT'
  ) THEN
    RAISE EXCEPTION 'a business must keep at least one active owner' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER membership_roles_keep_owner
  AFTER DELETE OR UPDATE ON membership_roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_assert_tenant_has_owner();
CREATE CONSTRAINT TRIGGER tenant_memberships_keep_owner
  AFTER UPDATE OF status ON tenant_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app_assert_tenant_has_owner();
