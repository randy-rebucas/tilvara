-- Hand-written: menu foundation (Phase 4 slice 2, ADR-0014 §2, §3, §5, §9).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kitchen_stations', 'dining_areas', 'restaurant_tables', 'modifier_groups', 'modifier_options',
                           'menus', 'menu_versions', 'menu_sections', 'menu_items', 'menu_item_modifier_groups',
                           'restaurant_settings', 'sold_out_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO onepos_readonly', t);
  END LOOP;
  -- Configuration that orders will reference: archived, never deleted.
  FOREACH t IN ARRAY ARRAY['kitchen_stations', 'dining_areas', 'restaurant_tables', 'modifier_groups', 'modifier_options', 'menus', 'menu_versions'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation()', t || '_no_delete', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['kitchen_stations', 'dining_areas', 'restaurant_tables', 'modifier_groups', 'menus'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()', t || '_touch_updated_at', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE (name, is_default, archived_at) ON kitchen_stations TO onepos_app;
GRANT SELECT, INSERT, UPDATE (name, sort_order, archived_at) ON dining_areas TO onepos_app;
GRANT SELECT, INSERT, UPDATE (area_id, code, seats, pos_x, pos_y, shape, archived_at) ON restaurant_tables TO onepos_app;
GRANT SELECT, INSERT, UPDATE (name, min_select, max_select, archived_at) ON modifier_groups TO onepos_app;
GRANT SELECT, INSERT, UPDATE (name, sort_order, archived_at) ON modifier_options TO onepos_app;
GRANT SELECT, INSERT, UPDATE (name, archived_at) ON menus TO onepos_app;
GRANT SELECT, INSERT, UPDATE (status, published_by, published_at, retired_at) ON menu_versions TO onepos_app;
-- A draft's content is replaced as a whole; published content is frozen by the trigger below.
GRANT SELECT, INSERT, UPDATE, DELETE ON menu_sections, menu_items, menu_item_modifier_groups TO onepos_app;
GRANT SELECT, INSERT, UPDATE (dine_in_menu_id, takeaway_menu_id, service_charge_rate, service_charge_dine_in, service_charge_takeaway,
                              service_charge_vat_treatment, updated_by, updated_at) ON restaurant_settings TO onepos_app;
-- 86 is live state: a row while sold out, deleted when back.
GRANT SELECT, INSERT, UPDATE (note, marked_by, marked_at), DELETE ON sold_out_items TO onepos_app;

-- Versions only move forward: DRAFT → PUBLISHED → RETIRED; identity never changes.
CREATE FUNCTION app_menu_version_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a menu version starts as a draft' USING ERRCODE = '23514', CONSTRAINT = 'menu_versions_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.menu_id <> OLD.menu_id OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'a menu version keeps its menu and number' USING ERRCODE = '23514', CONSTRAINT = 'menu_versions_transition';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED') OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'a % menu version cannot become %', lower(OLD.status), lower(NEW.status) USING ERRCODE = '23514', CONSTRAINT = 'menu_versions_transition';
  END IF;
  IF OLD.status <> 'DRAFT' AND (NEW.published_at IS DISTINCT FROM OLD.published_at OR NEW.published_by IS DISTINCT FROM OLD.published_by) THEN
    RAISE EXCEPTION 'publication details are fixed' USING ERRCODE = '23514', CONSTRAINT = 'menu_versions_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER menu_versions_transition BEFORE INSERT OR UPDATE ON menu_versions
  FOR EACH ROW EXECUTE FUNCTION app_menu_version_transition();

-- Content of a published or retired version is frozen (what was offered stays on record).
CREATE FUNCTION app_menu_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_tenant uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_id := OLD.menu_version_id; v_tenant := OLD.tenant_id;
  ELSE
    v_id := NEW.menu_version_id; v_tenant := NEW.tenant_id;
  END IF;
  SELECT status INTO v_status FROM menu_versions WHERE tenant_id = v_tenant AND id = v_id;
  IF v_status IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND OLD.menu_version_id <> NEW.menu_version_id) THEN
    RAISE EXCEPTION 'only a draft menu version can be edited' USING ERRCODE = '23514', CONSTRAINT = 'menu_versions_draft_only';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER menu_sections_draft_only BEFORE INSERT OR UPDATE OR DELETE ON menu_sections
  FOR EACH ROW EXECUTE FUNCTION app_menu_draft_only();
CREATE TRIGGER menu_items_draft_only BEFORE INSERT OR UPDATE OR DELETE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION app_menu_draft_only();
CREATE TRIGGER menu_item_modifier_groups_draft_only BEFORE INSERT OR UPDATE OR DELETE ON menu_item_modifier_groups
  FOR EACH ROW EXECUTE FUNCTION app_menu_draft_only();
