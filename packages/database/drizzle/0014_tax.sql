CREATE TABLE "discount_schemes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"vat_exempt" boolean NOT NULL,
	"base" text NOT NULL,
	"requires_id" boolean DEFAULT true NOT NULL,
	"review_status" text DEFAULT 'PENDING_PROFESSIONAL_REVIEW' NOT NULL,
	"legal_basis" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_schemes_code_version_unique" UNIQUE("code","version"),
	CONSTRAINT "discount_schemes_rate_check" CHECK ("discount_schemes"."rate" > 0 AND "discount_schemes"."rate" <= 1),
	CONSTRAINT "discount_schemes_base_check" CHECK ("discount_schemes"."base" IN ('VAT_EXCLUSIVE','GROSS')),
	CONSTRAINT "discount_schemes_review_check" CHECK ("discount_schemes"."review_status" IN ('PENDING_PROFESSIONAL_REVIEW','APPROVED'))
);
--> statement-breakpoint
CREATE TABLE "tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"vat_status" text NOT NULL,
	"vat_rate" numeric(9, 6) NOT NULL,
	"percentage_tax_rate" numeric(9, 6) NOT NULL,
	"rounding_mode" text DEFAULT 'HALF_UP' NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_profiles_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "tax_profiles_version_unique" UNIQUE("tenant_id","legal_entity_id","effective_from"),
	CONSTRAINT "tax_profiles_vat_status_check" CHECK ("tax_profiles"."vat_status" IN ('VAT','NON_VAT')),
	CONSTRAINT "tax_profiles_rounding_check" CHECK ("tax_profiles"."rounding_mode" IN ('HALF_UP','HALF_EVEN')),
	CONSTRAINT "tax_profiles_rates_check" CHECK (("tax_profiles"."vat_status" = 'VAT' AND "tax_profiles"."vat_rate" > 0 AND "tax_profiles"."vat_rate" < 1 AND "tax_profiles"."percentage_tax_rate" = 0)
       OR ("tax_profiles"."vat_status" = 'NON_VAT' AND "tax_profiles"."vat_rate" = 0 AND "tax_profiles"."percentage_tax_rate" >= 0 AND "tax_profiles"."percentage_tax_rate" < 1))
);
--> statement-breakpoint
ALTER TABLE "legal_entities" DROP CONSTRAINT "legal_entities_vat_status_check";--> statement-breakpoint
ALTER TABLE "legal_entities" DROP CONSTRAINT "legal_entities_rounding_check";--> statement-breakpoint
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_profiles_lookup_idx" ON "tax_profiles" USING btree ("tenant_id","legal_entity_id","effective_from" DESC NULLS LAST);--> statement-breakpoint
-- Hand-written backfill: every existing legal entity gets its current setting as the initial
-- tax profile, effective from the entity's creation. FORCE RLS also binds the owning role, so it
-- is lifted for this statement only. Rates are configuration (12 % VAT; 3 % percentage tax for
-- non-VAT sellers under the CREATE Act after 30 Jun 2023) — see ADR-0008.
ALTER TABLE "legal_entities" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "tax_profiles" ("tenant_id", "legal_entity_id", "effective_from", "vat_status", "vat_rate", "percentage_tax_rate", "rounding_mode", "note")
SELECT "tenant_id", "id", "created_at", "vat_status",
       CASE WHEN "vat_status" = 'VAT' THEN 0.12 ELSE 0 END,
       CASE WHEN "vat_status" = 'VAT' THEN 0 ELSE 0.03 END,
       "rounding_mode", 'Migrated from legal_entities (0014)'
  FROM "legal_entities";--> statement-breakpoint
ALTER TABLE "legal_entities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legal_entities" DROP COLUMN "vat_status";--> statement-breakpoint
ALTER TABLE "legal_entities" DROP COLUMN "rounding_mode";