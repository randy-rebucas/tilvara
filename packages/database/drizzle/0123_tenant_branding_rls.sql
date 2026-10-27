-- Hand-written: a business's branding (DDL in 0122).
-- * tenant_branding: one row per business, written in place by the API (audited); never deleted.
--   Changing it bumps the catalog version (0065), so tills fetch it with their next snapshot.
-- * brand_assets: immutable images; a replaced one is deleted once the branding no longer points at it
--   (the composite FK refuses deleting one in use).
-- * auth_public_shop(slug) / auth_public_shop_image(slug, kind): the public sign-in page at /s/<slug>
--   reads the shop's name and look before anyone signs in, so across tenants; only for a business that
--   switched the page on and is not closing.

ALTER TABLE tenant_branding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenant_branding FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant_branding USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
GRANT SELECT, INSERT ON tenant_branding TO onepos_app;--> statement-breakpoint
GRANT UPDATE (display_name, brand_color, logo_asset_id, background_asset_id, receipt_header, receipt_footer, contact_phone,
              contact_email, website, facebook, instagram, display_welcome, display_thanks, public_sign_in, updated_by, updated_at)
  ON tenant_branding TO onepos_app;--> statement-breakpoint
GRANT SELECT ON tenant_branding TO onepos_readonly, onepos_worker;--> statement-breakpoint
CREATE TRIGGER tenant_branding_no_delete BEFORE DELETE ON tenant_branding FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER tenant_branding_bump_catalog_version AFTER INSERT OR UPDATE OR DELETE ON tenant_branding FOR EACH STATEMENT EXECUTE FUNCTION app_bump_catalog_version();--> statement-breakpoint

ALTER TABLE brand_assets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE brand_assets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON brand_assets USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON brand_assets TO onepos_app;--> statement-breakpoint
GRANT SELECT ON brand_assets TO onepos_readonly, onepos_worker;--> statement-breakpoint

GRANT SELECT ON tenant_branding, brand_assets TO onepos_platform;--> statement-breakpoint
GRANT SELECT (slug, status) ON tenants TO onepos_platform;--> statement-breakpoint

CREATE FUNCTION auth_public_shop(p_slug text)
  RETURNS TABLE (tenant_id uuid, name text, display_name text, brand_color text, logo_sha256 text, background_sha256 text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, b.display_name, b.brand_color, l.sha256, g.sha256
    FROM tenants t
    JOIN tenant_branding b ON b.tenant_id = t.id AND b.public_sign_in
    LEFT JOIN brand_assets l ON l.tenant_id = t.id AND l.id = b.logo_asset_id
    LEFT JOIN brand_assets g ON g.tenant_id = t.id AND g.id = b.background_asset_id
   WHERE t.slug = p_slug AND t.status NOT IN ('OFFBOARDING', 'CLOSED')
$$;--> statement-breakpoint

CREATE FUNCTION auth_public_shop_image(p_slug text, p_kind text)
  RETURNS TABLE (content_type text, bytes bytea, sha256 text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.content_type, a.bytes, a.sha256
    FROM tenants t
    JOIN tenant_branding b ON b.tenant_id = t.id AND b.public_sign_in
    JOIN brand_assets a ON a.tenant_id = t.id
                       AND a.id = CASE p_kind WHEN 'LOGO' THEN b.logo_asset_id WHEN 'BACKGROUND' THEN b.background_asset_id END
   WHERE t.slug = p_slug AND t.status NOT IN ('OFFBOARDING', 'CLOSED')
$$;--> statement-breakpoint

GRANT USAGE, CREATE ON SCHEMA public TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION auth_public_shop(text) OWNER TO onepos_platform;--> statement-breakpoint
ALTER FUNCTION auth_public_shop_image(text, text) OWNER TO onepos_platform;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM onepos_platform;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_public_shop(text), auth_public_shop_image(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_public_shop(text), auth_public_shop_image(text, text) TO onepos_app;
