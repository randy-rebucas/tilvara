CREATE TABLE "inventory_settings" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"negative_stock_policy" text DEFAULT 'ALLOW' NOT NULL,
	"low_stock_alerts" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_settings_tenant_id_branch_id_pk" PRIMARY KEY("tenant_id","branch_id"),
	CONSTRAINT "inventory_settings_policy_check" CHECK ("inventory_settings"."negative_stock_policy" IN ('ALLOW','ALLOW_WITH_FLAG','BLOCK'))
);
--> statement-breakpoint
CREATE TABLE "stock_count_sheet_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sheet_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"expected_quantity" numeric(18, 4) NOT NULL,
	"counted_quantity" numeric(18, 4),
	"counted_by" uuid,
	"counted_at" timestamp with time zone,
	CONSTRAINT "stock_count_sheet_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_count_sheet_lines_variant_unique" UNIQUE("tenant_id","sheet_id","variant_id"),
	CONSTRAINT "stock_count_sheet_lines_counted_check" CHECK ("stock_count_sheet_lines"."counted_quantity" IS NULL OR "stock_count_sheet_lines"."counted_quantity" >= 0),
	CONSTRAINT "stock_count_sheet_lines_by_check" CHECK (("stock_count_sheet_lines"."counted_quantity" IS NULL) = ("stock_count_sheet_lines"."counted_by" IS NULL) AND ("stock_count_sheet_lines"."counted_by" IS NULL) = ("stock_count_sheet_lines"."counted_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "stock_count_sheets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"blind" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"notes" text,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"stock_count_id" uuid,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "stock_count_sheets_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_count_sheets_count_unique" UNIQUE("tenant_id","stock_count_id"),
	CONSTRAINT "stock_count_sheets_status_check" CHECK ("stock_count_sheets"."status" IN ('OPEN','POSTED','CANCELLED')),
	CONSTRAINT "stock_count_sheets_close_check" CHECK (("stock_count_sheets"."status" = 'OPEN') = ("stock_count_sheets"."closed_at" IS NULL) AND ("stock_count_sheets"."status" = 'POSTED') = ("stock_count_sheets"."stock_count_id" IS NOT NULL)
          AND ("stock_count_sheets"."status" <> 'CANCELLED' OR length(trim("stock_count_sheets"."cancel_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "below_zero" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD COLUMN "expected_quantity" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_sheet_lines" ADD CONSTRAINT "stock_count_sheet_lines_tenant_id_sheet_id_stock_count_sheets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sheet_id") REFERENCES "public"."stock_count_sheets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_sheet_lines" ADD CONSTRAINT "stock_count_sheet_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_sheets" ADD CONSTRAINT "stock_count_sheets_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_sheets" ADD CONSTRAINT "stock_count_sheets_tenant_id_stock_count_id_stock_counts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_count_id") REFERENCES "public"."stock_counts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_count_sheets_branch_idx" ON "stock_count_sheets" USING btree ("tenant_id","branch_id","frozen_at");