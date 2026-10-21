CREATE TABLE "dispense_approvals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approval_method" text NOT NULL,
	"allows_dangerous" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"sale_id" uuid,
	CONSTRAINT "dispense_approvals_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "dispense_approvals_method_check" CHECK ("dispense_approvals"."approval_method" IN ('SELF','CREDENTIALS'))
);
--> statement-breakpoint
CREATE TABLE "lot_holds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"branch_id" uuid,
	"reason" text NOT NULL,
	"reference" text,
	"placed_by" uuid NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "lot_holds_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "lot_holds_reason_check" CHECK (length(btrim("lot_holds"."reason")) BETWEEN 1 AND 200 AND length(btrim("lot_holds"."lot_code")) BETWEEN 1 AND 64),
	CONSTRAINT "lot_holds_release_check" CHECK (("lot_holds"."released_at" IS NULL) = ("lot_holds"."released_by" IS NULL) AND ("lot_holds"."released_at" IS NULL OR length(btrim(coalesce("lot_holds"."release_reason", ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "pharmacist_licenses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"license_no" text NOT NULL,
	"valid_until" date,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pharmacist_licenses_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "pharmacist_licenses_membership_once" UNIQUE("tenant_id","membership_id"),
	CONSTRAINT "pharmacist_licenses_no_check" CHECK (length(btrim("pharmacist_licenses"."license_no")) BETWEEN 3 AND 30)
);
--> statement-breakpoint
CREATE TABLE "pharmacy_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"require_purchase_booklet" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescription_fills" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"prescription_item_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"sale_return_line_id" uuid,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"pieces_per_unit" numeric(18, 4) NOT NULL,
	"dispensed_by" uuid NOT NULL,
	"approval_id" uuid,
	"needs_review" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescription_fills_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "prescription_fills_sign" CHECK ("prescription_fills"."quantity" <> 0 AND ("prescription_fills"."quantity" > 0) = ("prescription_fills"."sale_return_line_id" IS NULL)),
	CONSTRAINT "prescription_fills_pieces_check" CHECK ("prescription_fills"."pieces_per_unit" > 0)
);
--> statement-breakpoint
CREATE TABLE "prescription_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prescription_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"generic_name" text NOT NULL,
	"strength" text,
	"dosage_form" text NOT NULL,
	"generic_key" text GENERATED ALWAYS AS (lower(regexp_replace(btrim(generic_name), '\s+', ' ', 'g')) || '|' || lower(regexp_replace(coalesce(strength, ''), '\s+', '', 'g')) || '|' || coalesce(dosage_form, '')) STORED NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"drug_class" text NOT NULL,
	"directions" text,
	CONSTRAINT "prescription_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "prescription_items_line_unique" UNIQUE("tenant_id","prescription_id","line_no"),
	CONSTRAINT "prescription_items_quantity_check" CHECK ("prescription_items"."quantity" > 0),
	CONSTRAINT "prescription_items_generic_check" CHECK (length(btrim("prescription_items"."generic_name")) BETWEEN 1 AND 200),
	CONSTRAINT "prescription_items_class_check" CHECK ("prescription_items"."drug_class" IN ('OTC','RX','ANTIBIOTIC','DANGEROUS')),
	CONSTRAINT "prescription_items_form_check" CHECK ("prescription_items"."dosage_form" IN ('TABLET','CAPSULE','SYRUP','SUSPENSION','DROPS','CREAM','OINTMENT','INJECTION','INHALER','SACHET','OTHER'))
);
--> statement-breakpoint
CREATE TABLE "prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid,
	"patient_name" text NOT NULL,
	"patient_address" text,
	"prescriber_name" text NOT NULL,
	"prescriber_license_no" text NOT NULL,
	"prescriber_s2_no" text,
	"yellow_form_no" text,
	"issued_on" date NOT NULL,
	"notes" text,
	"source" text DEFAULT 'COUNTER' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	CONSTRAINT "prescriptions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "prescriptions_names_check" CHECK (length(btrim("prescriptions"."patient_name")) BETWEEN 1 AND 200 AND length(btrim("prescriptions"."prescriber_name")) BETWEEN 1 AND 200 AND length(btrim("prescriptions"."prescriber_license_no")) BETWEEN 3 AND 30),
	CONSTRAINT "prescriptions_source_check" CHECK ("prescriptions"."source" IN ('COUNTER','ADMIN','OFFLINE')),
	CONSTRAINT "prescriptions_void_check" CHECK (("prescriptions"."voided_at" IS NULL) = ("prescriptions"."voided_by" IS NULL) AND ("prescriptions"."voided_at" IS NULL OR length(btrim(coalesce("prescriptions"."void_reason", ''))) > 0))
);
--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_business_type_check";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "drug_class" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "generic_name" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "strength" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "dosage_form" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "fda_registration_no" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "generic_key" text GENERATED ALWAYS AS (CASE WHEN generic_name IS NULL THEN NULL ELSE lower(regexp_replace(btrim(generic_name), '\s+', ' ', 'g')) || '|' || lower(regexp_replace(coalesce(strength, ''), '\s+', '', 'g')) || '|' || coalesce(dosage_form, '') END) STORED;--> statement-breakpoint
ALTER TABLE "sale_beneficiaries" ADD COLUMN "purchase_booklet" boolean;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "drug_class" text;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "drug_label" text;--> statement-breakpoint
ALTER TABLE "stock_lot_movements" ADD COLUMN "expired" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD COLUMN "expired_stock" text;--> statement-breakpoint
ALTER TABLE "dispense_approvals" ADD CONSTRAINT "dispense_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_approvals" ADD CONSTRAINT "dispense_approvals_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispense_approvals" ADD CONSTRAINT "dispense_approvals_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_holds" ADD CONSTRAINT "lot_holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_holds" ADD CONSTRAINT "lot_holds_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_holds" ADD CONSTRAINT "lot_holds_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacist_licenses" ADD CONSTRAINT "pharmacist_licenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacist_licenses" ADD CONSTRAINT "pharmacist_licenses_tenant_id_membership_id_tenant_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pharmacy_settings" ADD CONSTRAINT "pharmacy_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_prescription_id_prescriptions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","prescription_id") REFERENCES "public"."prescriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_prescription_item_id_prescription_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","prescription_item_id") REFERENCES "public"."prescription_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_sale_line_id_sale_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_sale_return_line_id_sale_return_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_line_id") REFERENCES "public"."sale_return_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_fills" ADD CONSTRAINT "prescription_fills_tenant_id_approval_id_dispense_approvals_tenant_id_id_fk" FOREIGN KEY ("tenant_id","approval_id") REFERENCES "public"."dispense_approvals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_tenant_id_prescription_id_prescriptions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","prescription_id") REFERENCES "public"."prescriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lot_holds_open_once" ON "lot_holds" USING btree ("tenant_id","variant_id",upper(btrim("lot_code")),coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "lot_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "prescription_fills_item_idx" ON "prescription_fills" USING btree ("tenant_id","prescription_item_id");--> statement-breakpoint
CREATE INDEX "prescription_fills_prescription_idx" ON "prescription_fills" USING btree ("tenant_id","prescription_id");--> statement-breakpoint
CREATE INDEX "prescription_fills_sale_line_idx" ON "prescription_fills" USING btree ("tenant_id","sale_line_id");--> statement-breakpoint
CREATE INDEX "prescription_fills_branch_idx" ON "prescription_fills" USING btree ("tenant_id","branch_id","created_at");--> statement-breakpoint
CREATE INDEX "prescriptions_customer_idx" ON "prescriptions" USING btree ("tenant_id","customer_id") WHERE "prescriptions"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "prescriptions_branch_idx" ON "prescriptions" USING btree ("tenant_id","branch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "prescriptions_yellow_form_once" ON "prescriptions" USING btree ("tenant_id","legal_entity_id",upper(btrim("yellow_form_no"))) WHERE "prescriptions"."yellow_form_no" IS NOT NULL AND "prescriptions"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "products_generic_key_idx" ON "products" USING btree ("tenant_id","generic_key") WHERE "products"."generic_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_check" CHECK ("tenants"."business_type" IN ('RETAIL','RESTAURANT','HYBRID','GROCERY','SALON','LODGING','LAUNDRY','PHARMACY'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_drug_class_check" CHECK ("products"."drug_class" IS NULL OR ("products"."drug_class" IN ('OTC','RX','ANTIBIOTIC','DANGEROUS') AND "products"."product_type" = 'STANDARD' AND length(btrim(coalesce("products"."generic_name", ''))) BETWEEN 1 AND 200));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_dosage_form_check" CHECK ("products"."dosage_form" IS NULL OR "products"."dosage_form" IN ('TABLET','CAPSULE','SYRUP','SUSPENSION','DROPS','CREAM','OINTMENT','INJECTION','INHALER','SACHET','OTHER'));--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_expired_stock_check" CHECK ("inventory_settings"."expired_stock" IS NULL OR "inventory_settings"."expired_stock" IN ('ALLOW','BLOCK'));