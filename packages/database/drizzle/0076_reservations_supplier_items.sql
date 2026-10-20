CREATE TABLE "supplier_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"supplier_sku" text,
	"supplier_item_name" text,
	"unit_cost" numeric(20, 4),
	"preferred" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "supplier_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_items_cost_check" CHECK ("supplier_items"."unit_cost" IS NULL OR "supplier_items"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"note" text NOT NULL,
	"customer_id" uuid,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "stock_reservations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_reservations_quantity_positive" CHECK ("stock_reservations"."quantity" > 0),
	CONSTRAINT "stock_reservations_note_check" CHECK (length(trim("stock_reservations"."note")) BETWEEN 1 AND 200),
	CONSTRAINT "stock_reservations_status_check" CHECK ("stock_reservations"."status" IN ('ACTIVE','RELEASED')),
	CONSTRAINT "stock_reservations_released_check" CHECK (("stock_reservations"."status" = 'RELEASED') = ("stock_reservations"."released_at" IS NOT NULL) AND ("stock_reservations"."released_at" IS NULL) = ("stock_reservations"."released_by" IS NULL) AND ("stock_reservations"."released_at" IS NULL) = ("stock_reservations"."release_reason" IS NULL)),
	CONSTRAINT "stock_reservations_expiry_check" CHECK ("stock_reservations"."expires_at" IS NULL OR "stock_reservations"."expires_at" > "stock_reservations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_tenant_id_supplier_id_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_items" ADD CONSTRAINT "supplier_items_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_items_active_unique" ON "supplier_items" USING btree ("tenant_id","supplier_id","variant_id") WHERE "supplier_items"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_items_one_preferred" ON "supplier_items" USING btree ("tenant_id","variant_id") WHERE "supplier_items"."preferred" AND "supplier_items"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "supplier_items_variant_idx" ON "supplier_items" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_reservations_active_idx" ON "stock_reservations" USING btree ("tenant_id","branch_id","variant_id") WHERE "stock_reservations"."status" = 'ACTIVE';