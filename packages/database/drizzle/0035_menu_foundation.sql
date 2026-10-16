CREATE TABLE "dining_areas" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dining_areas_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "dining_areas_branch_id_unique" UNIQUE("tenant_id","branch_id","id"),
	CONSTRAINT "dining_areas_name_check" CHECK (length(trim("dining_areas"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "kitchen_stations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kitchen_stations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_stations_code_check" CHECK ("kitchen_stations"."code" ~ '^[A-Z][A-Z0-9_]{0,15}$'),
	CONSTRAINT "kitchen_stations_name_check" CHECK (length(trim("kitchen_stations"."name")) > 0),
	CONSTRAINT "kitchen_stations_default_active" CHECK (NOT ("kitchen_stations"."is_default" AND "kitchen_stations"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"tenant_id" uuid NOT NULL,
	"menu_version_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_item_modifier_groups_tenant_id_menu_item_id_modifier_group_id_pk" PRIMARY KEY("tenant_id","menu_item_id","modifier_group_id")
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"menu_version_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"display_name" text,
	"station_code" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_items_variant_unique" UNIQUE("tenant_id","menu_version_id","variant_id"),
	CONSTRAINT "menu_items_version_id_unique" UNIQUE("tenant_id","menu_version_id","id"),
	CONSTRAINT "menu_items_station_check" CHECK ("menu_items"."station_code" IS NULL OR "menu_items"."station_code" ~ '^[A-Z][A-Z0-9_]{0,15}$')
);
--> statement-breakpoint
CREATE TABLE "menu_sections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"menu_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_sections_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_sections_version_id_unique" UNIQUE("tenant_id","menu_version_id","id"),
	CONSTRAINT "menu_sections_name_check" CHECK (length(trim("menu_sections"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "menu_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"menu_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "menu_versions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "menu_versions_version_unique" UNIQUE("tenant_id","menu_id","version"),
	CONSTRAINT "menu_versions_status_check" CHECK ("menu_versions"."status" IN ('DRAFT','PUBLISHED','RETIRED')),
	CONSTRAINT "menu_versions_published_check" CHECK (("menu_versions"."status" = 'DRAFT') = ("menu_versions"."published_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "menus_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "menus_name_check" CHECK (length(trim("menus"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_groups_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "modifier_groups_name_check" CHECK (length(trim("modifier_groups"."name")) > 0),
	CONSTRAINT "modifier_groups_select_check" CHECK ("modifier_groups"."min_select" >= 0 AND "modifier_groups"."max_select" >= 1 AND "modifier_groups"."max_select" >= "modifier_groups"."min_select" AND "modifier_groups"."max_select" <= 20)
);
--> statement-breakpoint
CREATE TABLE "modifier_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"variant_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "modifier_options_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "modifier_options_name_check" CHECK (length(trim("modifier_options"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "restaurant_settings" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"dine_in_menu_id" uuid,
	"takeaway_menu_id" uuid,
	"service_charge_rate" numeric(9, 6) DEFAULT '0' NOT NULL,
	"service_charge_dine_in" boolean DEFAULT true NOT NULL,
	"service_charge_takeaway" boolean DEFAULT false NOT NULL,
	"service_charge_vat_treatment" text DEFAULT 'VATABLE' NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_settings_tenant_id_branch_id_pk" PRIMARY KEY("tenant_id","branch_id"),
	CONSTRAINT "restaurant_settings_rate_check" CHECK ("restaurant_settings"."service_charge_rate" >= 0 AND "restaurant_settings"."service_charge_rate" <= 0.3),
	CONSTRAINT "restaurant_settings_vat_check" CHECK ("restaurant_settings"."service_charge_vat_treatment" IN ('VATABLE','VAT_EXEMPT'))
);
--> statement-breakpoint
CREATE TABLE "restaurant_tables" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"code" text NOT NULL,
	"seats" integer DEFAULT 2 NOT NULL,
	"pos_x" integer,
	"pos_y" integer,
	"shape" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_tables_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "restaurant_tables_code_check" CHECK (length(trim("restaurant_tables"."code")) BETWEEN 1 AND 20),
	CONSTRAINT "restaurant_tables_seats_check" CHECK ("restaurant_tables"."seats" BETWEEN 1 AND 99),
	CONSTRAINT "restaurant_tables_shape_check" CHECK ("restaurant_tables"."shape" IS NULL OR "restaurant_tables"."shape" IN ('SQUARE','ROUND','RECT')),
	CONSTRAINT "restaurant_tables_pos_check" CHECK (("restaurant_tables"."pos_x" IS NULL) = ("restaurant_tables"."pos_y" IS NULL) AND coalesce("restaurant_tables"."pos_x", 0) BETWEEN 0 AND 999 AND coalesce("restaurant_tables"."pos_y", 0) BETWEEN 0 AND 999)
);
--> statement-breakpoint
CREATE TABLE "sold_out_items" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"note" text,
	"marked_by" uuid NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sold_out_items_tenant_id_branch_id_variant_id_pk" PRIMARY KEY("tenant_id","branch_id","variant_id")
);
--> statement-breakpoint
ALTER TABLE "dining_areas" ADD CONSTRAINT "dining_areas_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_tenant_id_menu_version_id_menu_item_id_menu_items_tenant_id_menu_version_id_id_fk" FOREIGN KEY ("tenant_id","menu_version_id","menu_item_id") REFERENCES "public"."menu_items"("tenant_id","menu_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_tenant_id_modifier_group_id_modifier_groups_tenant_id_id_fk" FOREIGN KEY ("tenant_id","modifier_group_id") REFERENCES "public"."modifier_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_menu_version_id_section_id_menu_sections_tenant_id_menu_version_id_id_fk" FOREIGN KEY ("tenant_id","menu_version_id","section_id") REFERENCES "public"."menu_sections"("tenant_id","menu_version_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_sections" ADD CONSTRAINT "menu_sections_tenant_id_menu_version_id_menu_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","menu_version_id") REFERENCES "public"."menu_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_versions" ADD CONSTRAINT "menu_versions_tenant_id_menu_id_menus_tenant_id_id_fk" FOREIGN KEY ("tenant_id","menu_id") REFERENCES "public"."menus"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_tenant_id_modifier_group_id_modifier_groups_tenant_id_id_fk" FOREIGN KEY ("tenant_id","modifier_group_id") REFERENCES "public"."modifier_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_tenant_id_dine_in_menu_id_menus_tenant_id_id_fk" FOREIGN KEY ("tenant_id","dine_in_menu_id") REFERENCES "public"."menus"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_tenant_id_takeaway_menu_id_menus_tenant_id_id_fk" FOREIGN KEY ("tenant_id","takeaway_menu_id") REFERENCES "public"."menus"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_tenant_id_branch_id_area_id_dining_areas_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","area_id") REFERENCES "public"."dining_areas"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sold_out_items" ADD CONSTRAINT "sold_out_items_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sold_out_items" ADD CONSTRAINT "sold_out_items_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dining_areas_name_active_unique" ON "dining_areas" USING btree ("tenant_id","branch_id",lower("name")) WHERE "dining_areas"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_stations_code_active_unique" ON "kitchen_stations" USING btree ("tenant_id","branch_id","code") WHERE "kitchen_stations"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "kitchen_stations_default_unique" ON "kitchen_stations" USING btree ("tenant_id","branch_id") WHERE "kitchen_stations"."is_default" AND "kitchen_stations"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "menu_versions_one_draft" ON "menu_versions" USING btree ("tenant_id","menu_id") WHERE "menu_versions"."status" = 'DRAFT';--> statement-breakpoint
CREATE UNIQUE INDEX "menu_versions_one_published" ON "menu_versions" USING btree ("tenant_id","menu_id") WHERE "menu_versions"."status" = 'PUBLISHED';--> statement-breakpoint
CREATE UNIQUE INDEX "menus_name_active_unique" ON "menus" USING btree ("tenant_id",lower("name")) WHERE "menus"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "modifier_options_name_active_unique" ON "modifier_options" USING btree ("tenant_id","modifier_group_id",lower("name")) WHERE "modifier_options"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "restaurant_tables_code_active_unique" ON "restaurant_tables" USING btree ("tenant_id","branch_id",lower("code")) WHERE "restaurant_tables"."archived_at" IS NULL;