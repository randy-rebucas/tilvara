CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_adjustments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_adjustments_kind_check" CHECK ("stock_adjustments"."kind" IN ('ADJUSTMENT','WASTE')),
	CONSTRAINT "stock_adjustments_reason_check" CHECK (length(trim("stock_adjustments"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "stock_adjustment_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_adjustments_branch_idx" ON "stock_adjustments" USING btree ("tenant_id","branch_id","created_at");--> statement-breakpoint
-- Hand-written backfill (Phase 3 exit review): every existing adjustment/waste becomes a document.
-- A document is the set of movements one request wrote (same tenant, branch, kind, reason, user
-- and transaction time). Its id is the movement id its journal entry already names (entries are
-- append-only), else the group's first movement id. FORCE RLS applies to the migrator too.
ALTER TABLE stock_movements NO FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_append_only;
CREATE TEMP TABLE adjustment_groups AS
SELECT m.id AS movement_id, m.tenant_id, m.branch_id, m.type, m.reason, m.created_by, m.created_at,
       dense_rank() OVER (ORDER BY m.tenant_id, m.branch_id, m.type, m.reason, m.created_by, m.created_at) AS g,
       e.source_id AS referenced
  FROM stock_movements m
  LEFT JOIN journal_entries e ON e.tenant_id = m.tenant_id AND e.source_type = 'STOCK_ADJUSTMENT' AND e.source_id = m.id
 WHERE m.type IN ('ADJUSTMENT', 'WASTE');
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM adjustment_groups GROUP BY g HAVING count(referenced) > 1) THEN
    RAISE EXCEPTION 'stock adjustment backfill: one group holds two journal entries';
  END IF;
END $$;
INSERT INTO stock_adjustments (id, tenant_id, branch_id, kind, reason, created_by, created_at)
SELECT coalesce(max(referenced::text), min(movement_id::text))::uuid, tenant_id, branch_id, type, reason, created_by, created_at
  FROM adjustment_groups GROUP BY g, tenant_id, branch_id, type, reason, created_by, created_at;
UPDATE stock_movements m SET stock_adjustment_id = d.id
  FROM adjustment_groups a JOIN stock_adjustments d
    ON d.tenant_id = a.tenant_id AND d.branch_id = a.branch_id AND d.kind = a.type AND d.reason = a.reason
   AND d.created_by = a.created_by AND d.created_at = a.created_at
 WHERE m.id = a.movement_id;
DROP TABLE adjustment_groups;
ALTER TABLE stock_movements ENABLE TRIGGER stock_movements_append_only;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stock_adjustments USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE TRIGGER stock_adjustments_append_only BEFORE UPDATE OR DELETE ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION app_forbid_mutation();
GRANT SELECT, INSERT ON stock_adjustments TO onepos_app;
GRANT SELECT ON stock_adjustments TO onepos_readonly;
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_stock_adjustment_id_stock_adjustments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_adjustment_id") REFERENCES "public"."stock_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_adjustment_link" CHECK (("stock_movements"."type" IN ('ADJUSTMENT','WASTE')) = ("stock_movements"."stock_adjustment_id" IS NOT NULL));