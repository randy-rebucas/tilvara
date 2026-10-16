ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_unique" UNIQUE("tenant_id","sale_id","id");--> statement-breakpoint
CREATE TABLE "order_bill_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_bill_id" uuid NOT NULL,
	"bill_line_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"share_num" bigint NOT NULL,
	"share_den" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_bill_allocations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_bill_allocations_sale_line_unique" UNIQUE("tenant_id","sale_line_id"),
	CONSTRAINT "order_bill_allocations_share_check" CHECK ("order_bill_allocations"."share_num" > 0 AND "order_bill_allocations"."share_den" > 0 AND "order_bill_allocations"."share_num" <= "order_bill_allocations"."share_den")
);
--> statement-breakpoint
CREATE TABLE "sale_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"order_bill_charge_id" uuid,
	"base" numeric(20, 4) NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"vat_treatment" text NOT NULL,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	"tax_snapshot" jsonb NOT NULL,
	CONSTRAINT "sale_charges_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_charges_kind_unique" UNIQUE("tenant_id","sale_id","kind"),
	CONSTRAINT "sale_charges_kind_check" CHECK ("sale_charges"."kind" IN ('SERVICE_CHARGE')),
	CONSTRAINT "sale_charges_due_check" CHECK ("sale_charges"."amount_due" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sale_return_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_return_id" uuid NOT NULL,
	"sale_charge_id" uuid NOT NULL,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	CONSTRAINT "sale_return_charges_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_return_charges_once" UNIQUE("tenant_id","sale_return_id","sale_charge_id")
);
--> statement-breakpoint
CREATE TABLE "order_bill_beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_bill_id" uuid NOT NULL,
	"scheme_code" text NOT NULL,
	"scheme_version" integer NOT NULL,
	"name" text NOT NULL,
	"id_number" text NOT NULL,
	"tin" text,
	CONSTRAINT "order_bill_beneficiaries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_bill_beneficiaries_name_check" CHECK (length(trim("order_bill_beneficiaries"."name")) > 0 AND length(trim("order_bill_beneficiaries"."id_number")) > 0)
);
--> statement-breakpoint
CREATE TABLE "order_bill_charges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_bill_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"base" numeric(20, 4) NOT NULL,
	"rate" numeric(9, 6) NOT NULL,
	"vat_treatment" text NOT NULL,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	"tax_snapshot" jsonb NOT NULL,
	CONSTRAINT "order_bill_charges_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_bill_charges_kind_unique" UNIQUE("tenant_id","order_bill_id","kind"),
	CONSTRAINT "order_bill_charges_kind_check" CHECK ("order_bill_charges"."kind" IN ('SERVICE_CHARGE')),
	CONSTRAINT "order_bill_charges_amount_check" CHECK ("order_bill_charges"."amount_due" > 0 AND "order_bill_charges"."rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "order_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_bill_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"parent_line_id" uuid,
	"order_item_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"tax_category_code" text NOT NULL,
	"vat_treatment" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(20, 4) NOT NULL,
	"price_includes_tax" boolean NOT NULL,
	"price_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"track_inventory" boolean NOT NULL,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	"beneficiary_id" uuid,
	"scheme_share" numeric(9, 6),
	"tax_snapshot" jsonb NOT NULL,
	CONSTRAINT "order_bill_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_bill_lines_bill_id_unique" UNIQUE("tenant_id","order_bill_id","id"),
	CONSTRAINT "order_bill_lines_number_unique" UNIQUE("tenant_id","order_bill_id","line_no"),
	CONSTRAINT "order_bill_lines_quantity_check" CHECK ("order_bill_lines"."quantity" > 0),
	CONSTRAINT "order_bill_lines_beneficiary_share" CHECK (("order_bill_lines"."beneficiary_id" IS NULL) = ("order_bill_lines"."scheme_share" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "order_bills" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"bill_number" bigint NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_profile_id" uuid NOT NULL,
	"tax_snapshot" jsonb NOT NULL,
	"discount_rate" numeric(9, 6),
	"requires_professional_review" boolean NOT NULL,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"settled_at" timestamp with time zone,
	CONSTRAINT "order_bills_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_bills_number_unique" UNIQUE("tenant_id","branch_id","bill_number"),
	CONSTRAINT "order_bills_status_check" CHECK ("order_bills"."status" IN ('ACTIVE','SETTLED','VOIDED')),
	CONSTRAINT "order_bills_void_check" CHECK (("order_bills"."status" = 'VOIDED') = ("order_bills"."voided_at" IS NOT NULL) AND ("order_bills"."voided_at" IS NULL OR length(trim(coalesce("order_bills"."void_reason", ''))) > 0)),
	CONSTRAINT "order_bills_buckets_check" CHECK ("order_bills"."amount_due" = "order_bills"."vatable_sales" + "order_bills"."vat_amount" + "order_bills"."vat_exempt_sales" + "order_bills"."zero_rated_sales" + "order_bills"."percentage_tax_sales" - "order_bills"."statutory_discount")
);
--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "parent_line_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "order_bill_id" uuid;--> statement-breakpoint
ALTER TABLE "order_bill_allocations" ADD CONSTRAINT "order_bill_allocations_tenant_id_order_bill_id_bill_line_id_order_bill_lines_tenant_id_order_bill_id_id_fk" FOREIGN KEY ("tenant_id","order_bill_id","bill_line_id") REFERENCES "public"."order_bill_lines"("tenant_id","order_bill_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_allocations" ADD CONSTRAINT "order_bill_allocations_tenant_id_sale_id_sale_line_id_sale_lines_tenant_id_sale_id_id_fk" FOREIGN KEY ("tenant_id","sale_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","sale_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_charges" ADD CONSTRAINT "sale_charges_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_charges" ADD CONSTRAINT "sale_charges_tenant_id_order_bill_charge_id_order_bill_charges_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_bill_charge_id") REFERENCES "public"."order_bill_charges"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_return_charges" ADD CONSTRAINT "sale_return_charges_tenant_id_sale_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_return_charges" ADD CONSTRAINT "sale_return_charges_tenant_id_sale_charge_id_sale_charges_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_charge_id") REFERENCES "public"."sale_charges"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_beneficiaries" ADD CONSTRAINT "order_bill_beneficiaries_tenant_id_order_bill_id_order_bills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_bill_id") REFERENCES "public"."order_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_charges" ADD CONSTRAINT "order_bill_charges_tenant_id_order_bill_id_order_bills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_bill_id") REFERENCES "public"."order_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_lines" ADD CONSTRAINT "order_bill_lines_tenant_id_order_bill_id_order_bills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_bill_id") REFERENCES "public"."order_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_lines" ADD CONSTRAINT "order_bill_lines_tenant_id_order_bill_id_parent_line_id_order_bill_lines_tenant_id_order_bill_id_id_fk" FOREIGN KEY ("tenant_id","order_bill_id","parent_line_id") REFERENCES "public"."order_bill_lines"("tenant_id","order_bill_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_lines" ADD CONSTRAINT "order_bill_lines_tenant_id_order_item_id_order_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_item_id") REFERENCES "public"."order_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_lines" ADD CONSTRAINT "order_bill_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_lines" ADD CONSTRAINT "order_bill_lines_tenant_id_price_id_product_prices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_id") REFERENCES "public"."product_prices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bill_lines" ADD CONSTRAINT "order_bill_lines_tenant_id_beneficiary_id_order_bill_beneficiaries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","beneficiary_id") REFERENCES "public"."order_bill_beneficiaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bills" ADD CONSTRAINT "order_bills_tenant_id_branch_id_order_id_restaurant_orders_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","order_id") REFERENCES "public"."restaurant_orders"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bills" ADD CONSTRAINT "order_bills_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_bills" ADD CONSTRAINT "order_bills_tenant_id_tax_profile_id_tax_profiles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","tax_profile_id") REFERENCES "public"."tax_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_bill_allocations_line_idx" ON "order_bill_allocations" USING btree ("tenant_id","bill_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_bills_one_active" ON "order_bills" USING btree ("tenant_id","order_id") WHERE "order_bills"."status" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_sale_id_parent_line_id_sale_lines_tenant_id_sale_id_id_fk" FOREIGN KEY ("tenant_id","sale_id","parent_line_id") REFERENCES "public"."sale_lines"("tenant_id","sale_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_order_bill_id_order_bills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_bill_id") REFERENCES "public"."order_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_bill_idx" ON "sales" USING btree ("tenant_id","order_bill_id");
