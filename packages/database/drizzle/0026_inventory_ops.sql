CREATE TABLE "reorder_points" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"reorder_point" numeric(18, 4) NOT NULL,
	"reorder_quantity" numeric(18, 4),
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reorder_points_tenant_id_branch_id_variant_id_pk" PRIMARY KEY("tenant_id","branch_id","variant_id"),
	CONSTRAINT "reorder_points_check" CHECK ("reorder_points"."reorder_point" >= 0 AND ("reorder_points"."reorder_quantity" IS NULL OR "reorder_points"."reorder_quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"counted_quantity" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_count_lines_variant_unique" UNIQUE("tenant_id","stock_count_id","variant_id"),
	CONSTRAINT "stock_count_lines_quantity_check" CHECK ("stock_count_lines"."counted_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"count_number" bigint NOT NULL,
	"notes" text,
	"counted_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_counts_number_unique" UNIQUE("tenant_id","branch_id","count_number")
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stock_transfer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"received_quantity" numeric(18, 4),
	"discrepancy_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfer_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_transfer_lines_variant_unique" UNIQUE("tenant_id","stock_transfer_id","variant_id"),
	CONSTRAINT "stock_transfer_lines_quantity_check" CHECK ("stock_transfer_lines"."quantity" > 0),
	CONSTRAINT "stock_transfer_lines_received_check" CHECK ("stock_transfer_lines"."received_quantity" IS NULL OR ("stock_transfer_lines"."received_quantity" >= 0 AND "stock_transfer_lines"."received_quantity" <= "stock_transfer_lines"."quantity" AND ("stock_transfer_lines"."received_quantity" = "stock_transfer_lines"."quantity" OR length(trim(coalesce("stock_transfer_lines"."discrepancy_reason", ''))) > 0)))
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_branch_id" uuid NOT NULL,
	"to_branch_id" uuid NOT NULL,
	"transfer_number" bigint NOT NULL,
	"status" text DEFAULT 'DISPATCHED' NOT NULL,
	"notes" text,
	"dispatched_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	"receive_notes" text,
	CONSTRAINT "stock_transfers_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_transfers_number_unique" UNIQUE("tenant_id","from_branch_id","transfer_number"),
	CONSTRAINT "stock_transfers_branches_check" CHECK ("stock_transfers"."from_branch_id" <> "stock_transfers"."to_branch_id"),
	CONSTRAINT "stock_transfers_status_check" CHECK ("stock_transfers"."status" IN ('DISPATCHED','RECEIVED'))
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_direction";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_reason";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "stock_transfer_line_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "stock_count_line_id" uuid;--> statement-breakpoint
ALTER TABLE "reorder_points" ADD CONSTRAINT "reorder_points_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_points" ADD CONSTRAINT "reorder_points_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_stock_count_id_stock_counts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_count_id") REFERENCES "public"."stock_counts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_stock_transfer_id_stock_transfers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_transfer_id") REFERENCES "public"."stock_transfers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_from_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","from_branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_to_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","to_branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_transfers_to_idx" ON "stock_transfers" USING btree ("tenant_id","to_branch_id","status");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_stock_transfer_line_id_stock_transfer_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_transfer_line_id") REFERENCES "public"."stock_transfer_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_stock_count_line_id_stock_count_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stock_count_line_id") REFERENCES "public"."stock_count_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_transfer_link" CHECK (("stock_movements"."type" IN ('TRANSFER_OUT','TRANSFER_IN')) = ("stock_movements"."stock_transfer_line_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_count_link" CHECK (("stock_movements"."type" = 'COUNT') = ("stock_movements"."stock_count_line_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" IN ('SALE','ADJUSTMENT','RETURN','RECEIPT','SUPPLIER_RETURN','TRANSFER_OUT','TRANSFER_IN','WASTE','COUNT'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_direction" CHECK (("stock_movements"."type" IN ('SALE','SUPPLIER_RETURN','TRANSFER_OUT','WASTE') AND "stock_movements"."quantity" < 0) OR ("stock_movements"."type" IN ('RETURN','RECEIPT','TRANSFER_IN') AND "stock_movements"."quantity" > 0) OR "stock_movements"."type" IN ('ADJUSTMENT','COUNT'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason" CHECK ("stock_movements"."type" NOT IN ('ADJUSTMENT','WASTE') OR length(trim(coalesce("stock_movements"."reason", ''))) > 0);