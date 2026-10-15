CREATE TABLE "barcodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "barcodes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "barcodes_code_format" CHECK ("barcodes"."code" ~ '^[A-Za-z0-9-]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "branch_price_lists" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branch_price_lists_tenant_id_branch_id_pk" PRIMARY KEY("tenant_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "categories_not_own_parent" CHECK ("categories"."parent_id" IS DISTINCT FROM "categories"."id")
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"prices_include_tax" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_lists_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_lists_tenant_name_unique" UNIQUE("tenant_id","name"),
	CONSTRAINT "price_lists_default_not_archived" CHECK (NOT ("price_lists"."is_default" AND "price_lists"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "product_prices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_prices_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_prices_version_unique" UNIQUE("tenant_id","price_list_id","variant_id","effective_from"),
	CONSTRAINT "product_prices_amount_non_negative" CHECK ("product_prices"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reference_cost" numeric(20, 4),
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "product_variants_sku_format" CHECK ("product_variants"."sku" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
	CONSTRAINT "product_variants_cost_non_negative" CHECK ("product_variants"."reference_cost" IS NULL OR "product_variants"."reference_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category_id" uuid,
	"tax_category_id" uuid NOT NULL,
	"uom_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"product_type" text DEFAULT 'STANDARD' NOT NULL,
	"sold_by" text DEFAULT 'UNIT' NOT NULL,
	"track_inventory" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_type_check" CHECK ("products"."product_type" IN ('STANDARD','SERVICE')),
	CONSTRAINT "products_sold_by_check" CHECK ("products"."sold_by" IN ('UNIT','WEIGHT')),
	CONSTRAINT "products_service_untracked" CHECK ("products"."product_type" <> 'SERVICE' OR NOT "products"."track_inventory")
);
--> statement-breakpoint
CREATE TABLE "tax_categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"vat_treatment" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_categories_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_categories_tenant_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "tax_categories_vat_treatment_check" CHECK ("tax_categories"."vat_treatment" IN ('VATABLE','VAT_EXEMPT','ZERO_RATED')),
	CONSTRAINT "tax_categories_code_format" CHECK ("tax_categories"."code" ~ '^[A-Z][A-Z0-9_]{0,29}$')
);
--> statement-breakpoint
CREATE TABLE "units_of_measure" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"allows_fraction" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_of_measure_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "units_of_measure_tenant_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "units_of_measure_code_format" CHECK ("units_of_measure"."code" ~ '^[A-Z][A-Z0-9]{0,9}$')
);
--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_price_lists" ADD CONSTRAINT "branch_price_lists_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_price_lists" ADD CONSTRAINT "branch_price_lists_tenant_id_price_list_id_price_lists_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_parent_id_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_tenant_id_price_list_id_price_lists_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_list_id") REFERENCES "public"."price_lists"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_category_id_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","category_id") REFERENCES "public"."categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tax_category_id_tax_categories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","tax_category_id") REFERENCES "public"."tax_categories"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_uom_id_units_of_measure_tenant_id_id_fk" FOREIGN KEY ("tenant_id","uom_id") REFERENCES "public"."units_of_measure"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_categories" ADD CONSTRAINT "tax_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units_of_measure" ADD CONSTRAINT "units_of_measure_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "barcodes_tenant_code_active_unique" ON "barcodes" USING btree ("tenant_id","code") WHERE "barcodes"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "barcodes_variant_idx" ON "barcodes" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_lists_one_default" ON "price_lists" USING btree ("tenant_id") WHERE "price_lists"."is_default";--> statement-breakpoint
CREATE INDEX "product_prices_lookup_idx" ON "product_prices" USING btree ("tenant_id","price_list_id","variant_id","effective_from" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_tenant_sku_unique" ON "product_variants" USING btree ("tenant_id",lower("sku")) WHERE "product_variants"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "products_tenant_name_idx" ON "products" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "products_tenant_category_idx" ON "products" USING btree ("tenant_id","category_id");