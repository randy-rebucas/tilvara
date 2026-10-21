CREATE TABLE "promotion_branches" (
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	CONSTRAINT "promotion_branches_tenant_id_promotion_id_branch_id_pk" PRIMARY KEY("tenant_id","promotion_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "promotion_items" (
	"tenant_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "promotion_items_tenant_id_promotion_id_variant_id_pk" PRIMARY KEY("tenant_id","promotion_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer,
	"price" numeric(20, 4),
	"buy_quantity" integer,
	"get_quantity" integer,
	"get_rate" numeric(7, 6),
	"tiers" jsonb,
	"all_branches" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "promotions_kind_check" CHECK ("promotions"."kind" IN ('MULTI_BUY','BUY_X_GET_Y','QUANTITY_BREAK')),
	CONSTRAINT "promotions_name_check" CHECK (length(btrim("promotions"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "promotions_window_check" CHECK ("promotions"."ends_at" IS NULL OR "promotions"."ends_at" >= "promotions"."starts_at"),
	CONSTRAINT "promotions_terms_check" CHECK (CASE "promotions"."kind"
        WHEN 'MULTI_BUY' THEN coalesce("promotions"."quantity" >= 2 AND "promotions"."price" >= 0 AND "promotions"."buy_quantity" IS NULL AND "promotions"."get_quantity" IS NULL AND "promotions"."get_rate" IS NULL AND "promotions"."tiers" IS NULL, false)
        WHEN 'BUY_X_GET_Y' THEN coalesce("promotions"."buy_quantity" >= 1 AND "promotions"."get_quantity" >= 1 AND "promotions"."get_rate" > 0 AND "promotions"."get_rate" <= 1 AND "promotions"."quantity" IS NULL AND "promotions"."price" IS NULL AND "promotions"."tiers" IS NULL, false)
        ELSE coalesce(jsonb_typeof("promotions"."tiers") = 'array' AND jsonb_array_length("promotions"."tiers") BETWEEN 1 AND 5 AND "promotions"."quantity" IS NULL AND "promotions"."price" IS NULL AND "promotions"."buy_quantity" IS NULL AND "promotions"."get_quantity" IS NULL AND "promotions"."get_rate" IS NULL, false)
      END)
);
--> statement-breakpoint
CREATE TABLE "item_locations" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_locations_tenant_id_branch_id_variant_id_pk" PRIMARY KEY("tenant_id","branch_id","variant_id"),
	CONSTRAINT "item_locations_location_check" CHECK (length(btrim("item_locations"."location")) BETWEEN 1 AND 32)
);
--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "quick_key_position" integer;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "promotion_id" uuid;--> statement-breakpoint
ALTER TABLE "promotion_branches" ADD CONSTRAINT "promotion_branches_tenant_id_promotion_id_promotions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_branches" ADD CONSTRAINT "promotion_branches_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_tenant_id_promotion_id_promotions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_items" ADD CONSTRAINT "promotion_items_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_locations" ADD CONSTRAINT "item_locations_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_locations" ADD CONSTRAINT "item_locations_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promotion_items_variant_idx" ON "promotion_items" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE INDEX "promotions_window_idx" ON "promotions" USING btree ("tenant_id","starts_at","ends_at");--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_promotion_id_promotions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_lines_promotion_idx" ON "sale_lines" USING btree ("tenant_id","promotion_id") WHERE "sale_lines"."promotion_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_quick_key_range" CHECK ("product_variants"."quick_key_position" IS NULL OR "product_variants"."quick_key_position" BETWEEN 1 AND 48);