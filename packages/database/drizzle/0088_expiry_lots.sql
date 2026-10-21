CREATE TABLE "stock_lot_movements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_lot_movements_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_lot_movements_nonzero" CHECK ("stock_lot_movements"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"expires_on" date NOT NULL,
	"lot_code" text,
	"quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_lots_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_lots_quantity_check" CHECK ("stock_lots"."quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tracks_expiry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "lot_code" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "lot_code" text;--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD COLUMN "expiry_alert_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_lot_movements" ADD CONSTRAINT "stock_lot_movements_tenant_id_lot_id_stock_lots_tenant_id_id_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."stock_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lot_movements" ADD CONSTRAINT "stock_lot_movements_tenant_id_movement_id_stock_movements_tenant_id_id_fk" FOREIGN KEY ("tenant_id","movement_id") REFERENCES "public"."stock_movements"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_lot_movements_movement_idx" ON "stock_lot_movements" USING btree ("tenant_id","movement_id");--> statement-breakpoint
CREATE INDEX "stock_lot_movements_lot_idx" ON "stock_lot_movements" USING btree ("tenant_id","lot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_lots_identity" ON "stock_lots" USING btree ("tenant_id","branch_id","variant_id","expires_on",coalesce("lot_code", ''));--> statement-breakpoint
CREATE INDEX "stock_lots_expiring_idx" ON "stock_lots" USING btree ("tenant_id","branch_id","expires_on") WHERE "stock_lots"."quantity" > 0;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_lot_id_stock_lots_tenant_id_id_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."stock_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_dated_inbound" CHECK ("stock_movements"."expires_on" IS NULL OR ("stock_movements"."quantity" > 0 AND "stock_movements"."type" IN ('RECEIPT','ADJUSTMENT')));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_needs_date" CHECK ("stock_movements"."lot_code" IS NULL OR "stock_movements"."expires_on" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_named_lot" CHECK ("stock_movements"."lot_id" IS NULL OR ("stock_movements"."quantity" < 0 AND "stock_movements"."type" IN ('ADJUSTMENT','WASTE')));--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_lot_needs_date" CHECK ("goods_receipt_lines"."lot_code" IS NULL OR "goods_receipt_lines"."expires_on" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_expiry_days_check" CHECK ("inventory_settings"."expiry_alert_days" BETWEEN 0 AND 365);