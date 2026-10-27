CREATE TABLE "brand_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_assets_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "brand_assets_kind_check" CHECK ("brand_assets"."kind" IN ('LOGO','BACKGROUND')),
	CONSTRAINT "brand_assets_content_type_check" CHECK ("brand_assets"."content_type" IN ('image/png','image/jpeg','image/webp')),
	CONSTRAINT "brand_assets_size_check" CHECK ("brand_assets"."size_bytes" = octet_length("brand_assets"."bytes") AND "brand_assets"."size_bytes" <= 1048576),
	CONSTRAINT "brand_assets_sha256_format" CHECK ("brand_assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "brand_assets_dimensions_check" CHECK ("brand_assets"."width" BETWEEN 1 AND 8192 AND "brand_assets"."height" BETWEEN 1 AND 8192)
);
--> statement-breakpoint
CREATE TABLE "tenant_branding" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"brand_color" text,
	"logo_asset_id" uuid,
	"background_asset_id" uuid,
	"receipt_header" text,
	"receipt_footer" text,
	"contact_phone" text,
	"contact_email" text,
	"website" text,
	"facebook" text,
	"instagram" text,
	"display_welcome" text,
	"display_thanks" text,
	"public_sign_in" boolean DEFAULT false NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_branding_color_format" CHECK ("tenant_branding"."brand_color" IS NULL OR "tenant_branding"."brand_color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_tenant_id_created_by_tenant_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_logo_asset_id_brand_assets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","logo_asset_id") REFERENCES "public"."brand_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_background_asset_id_brand_assets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","background_asset_id") REFERENCES "public"."brand_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_branding" ADD CONSTRAINT "tenant_branding_tenant_id_updated_by_tenant_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","updated_by") REFERENCES "public"."tenant_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_assets_tenant_idx" ON "brand_assets" USING btree ("tenant_id","kind");