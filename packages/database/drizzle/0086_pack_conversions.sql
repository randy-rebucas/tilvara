CREATE TABLE "pack_conversions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pack_variant_id" uuid NOT NULL,
	"piece_variant_id" uuid NOT NULL,
	"pieces_per_pack" numeric(18, 4) NOT NULL,
	"auto_open" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "pack_conversions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "pack_conversions_distinct" CHECK ("pack_conversions"."pack_variant_id" <> "pack_conversions"."piece_variant_id"),
	CONSTRAINT "pack_conversions_count" CHECK ("pack_conversions"."pieces_per_pack" > 1)
);
--> statement-breakpoint
CREATE TABLE "pack_openings" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"conversion_id" uuid NOT NULL,
	"packs" numeric(18, 4) NOT NULL,
	"pieces" numeric(18, 4) NOT NULL,
	"sale_id" uuid,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pack_openings_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "pack_openings_whole_packs" CHECK ("pack_openings"."packs" > 0 AND "pack_openings"."packs" = trunc("pack_openings"."packs")),
	CONSTRAINT "pack_openings_pieces" CHECK ("pack_openings"."pieces" > 0),
	CONSTRAINT "pack_openings_reason" CHECK ("pack_openings"."sale_id" IS NOT NULL OR length(trim(coalesce("pack_openings"."reason", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_direction";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "pack_opening_id" uuid;--> statement-breakpoint
ALTER TABLE "pack_conversions" ADD CONSTRAINT "pack_conversions_tenant_id_pack_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","pack_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_conversions" ADD CONSTRAINT "pack_conversions_tenant_id_piece_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","piece_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_openings" ADD CONSTRAINT "pack_openings_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_openings" ADD CONSTRAINT "pack_openings_tenant_id_conversion_id_pack_conversions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","conversion_id") REFERENCES "public"."pack_conversions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_openings" ADD CONSTRAINT "pack_openings_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pack_conversions_one_pack_per_piece" ON "pack_conversions" USING btree ("tenant_id","piece_variant_id") WHERE "pack_conversions"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pack_conversions_pack_idx" ON "pack_conversions" USING btree ("tenant_id","pack_variant_id");--> statement-breakpoint
CREATE INDEX "pack_openings_branch_idx" ON "pack_openings" USING btree ("tenant_id","branch_id","created_at");--> statement-breakpoint
CREATE INDEX "pack_openings_sale_idx" ON "pack_openings" USING btree ("tenant_id","sale_id") WHERE "pack_openings"."sale_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_pack_opening_id_pack_openings_tenant_id_id_fk" FOREIGN KEY ("tenant_id","pack_opening_id") REFERENCES "public"."pack_openings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_pack_opening_link" CHECK (("stock_movements"."type" IN ('UNPACK_OUT','UNPACK_IN')) = ("stock_movements"."pack_opening_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" IN ('SALE','ADJUSTMENT','RETURN','RECEIPT','SUPPLIER_RETURN','TRANSFER_OUT','TRANSFER_IN','WASTE','COUNT','CONSUMPTION','UNPACK_OUT','UNPACK_IN'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_direction" CHECK (("stock_movements"."type" IN ('SALE','SUPPLIER_RETURN','TRANSFER_OUT','WASTE','CONSUMPTION','UNPACK_OUT') AND "stock_movements"."quantity" < 0) OR ("stock_movements"."type" IN ('RETURN','RECEIPT','TRANSFER_IN','UNPACK_IN') AND "stock_movements"."quantity" > 0) OR "stock_movements"."type" IN ('ADJUSTMENT','COUNT'));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','SUPPLIER_NOTE','PACK_OPENING','MANUAL','REVERSAL'));