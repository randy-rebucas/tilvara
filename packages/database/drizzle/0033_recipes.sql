CREATE TABLE "recipe_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"recipe_version_id" uuid NOT NULL,
	"ingredient_variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_ingredients_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "recipe_ingredients_ingredient_unique" UNIQUE("tenant_id","recipe_version_id","ingredient_variant_id"),
	CONSTRAINT "recipe_ingredients_quantity_check" CHECK ("recipe_ingredients"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "recipe_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recipe_versions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "recipe_versions_version_unique" UNIQUE("tenant_id","variant_id","version"),
	CONSTRAINT "recipe_versions_effective_unique" UNIQUE("tenant_id","variant_id","effective_from"),
	CONSTRAINT "recipe_versions_version_check" CHECK ("recipe_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_sale_link";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_direction";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "recipe_version_id" uuid;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_tenant_id_recipe_version_id_recipe_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","recipe_version_id") REFERENCES "public"."recipe_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD CONSTRAINT "recipe_ingredients_tenant_id_ingredient_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ingredient_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recipe_versions_lookup_idx" ON "recipe_versions" USING btree ("tenant_id","variant_id","effective_from" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_recipe_version_id_recipe_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","recipe_version_id") REFERENCES "public"."recipe_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_consumption_link" CHECK (("stock_movements"."type" = 'CONSUMPTION') = ("stock_movements"."recipe_version_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" IN ('SALE','ADJUSTMENT','RETURN','RECEIPT','SUPPLIER_RETURN','TRANSFER_OUT','TRANSFER_IN','WASTE','COUNT','CONSUMPTION'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sale_link" CHECK (("stock_movements"."type" IN ('SALE','RETURN','CONSUMPTION')) = ("stock_movements"."sale_line_id" IS NOT NULL AND "stock_movements"."sale_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_direction" CHECK (("stock_movements"."type" IN ('SALE','SUPPLIER_RETURN','TRANSFER_OUT','WASTE','CONSUMPTION') AND "stock_movements"."quantity" < 0) OR ("stock_movements"."type" IN ('RETURN','RECEIPT','TRANSFER_IN') AND "stock_movements"."quantity" > 0) OR "stock_movements"."type" IN ('ADJUSTMENT','COUNT'));