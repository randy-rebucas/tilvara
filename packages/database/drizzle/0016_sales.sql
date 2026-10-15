-- Moved first by hand: the composite FKs below reference this key.
ALTER TABLE "registers" ADD CONSTRAINT "registers_tenant_branch_id_unique" UNIQUE("tenant_id","branch_id","id");--> statement-breakpoint
CREATE TABLE "cash_movements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cashier_session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"reason" text,
	"sale_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_movements_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT')),
	CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" = 'PAY_OUT' AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" IN ('PAY_IN') AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0)),
	CONSTRAINT "cash_movements_reason_check" CHECK ("cash_movements"."type" NOT IN ('PAY_IN','PAY_OUT') OR length(trim(coalesce("cash_movements"."reason", ''))) > 0)
);
--> statement-breakpoint
CREATE TABLE "cash_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cashier_session_id" uuid NOT NULL,
	"expected_cash" numeric(20, 4) NOT NULL,
	"counted_cash" numeric(20, 4) NOT NULL,
	"variance" numeric(20, 4) NOT NULL,
	"counted_by" uuid NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	CONSTRAINT "cash_reconciliations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "cash_reconciliations_session_unique" UNIQUE("tenant_id","cashier_session_id"),
	CONSTRAINT "cash_reconciliations_variance_check" CHECK ("cash_reconciliations"."variance" = "cash_reconciliations"."counted_cash" - "cash_reconciliations"."expected_cash"),
	CONSTRAINT "cash_reconciliations_counted_check" CHECK ("cash_reconciliations"."counted_cash" >= 0),
	CONSTRAINT "cash_reconciliations_approval_check" CHECK (("cash_reconciliations"."approved_by" IS NULL) = ("cash_reconciliations"."approved_at" IS NULL)),
	CONSTRAINT "cash_reconciliations_not_self_approved" CHECK ("cash_reconciliations"."approved_by" IS NULL OR "cash_reconciliations"."approved_by" <> "cash_reconciliations"."counted_by")
);
--> statement-breakpoint
CREATE TABLE "cashier_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opening_float" numeric(20, 4) NOT NULL,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "cashier_sessions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "cashier_sessions_status_check" CHECK ("cashier_sessions"."status" IN ('OPEN','CLOSED','RECONCILED')),
	CONSTRAINT "cashier_sessions_float_check" CHECK ("cashier_sessions"."opening_float" >= 0),
	CONSTRAINT "cashier_sessions_closed_check" CHECK (("cashier_sessions"."status" = 'OPEN') = ("cashier_sessions"."closed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sale_beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"scheme_code" text NOT NULL,
	"scheme_version" integer NOT NULL,
	"name" text NOT NULL,
	"id_number" text NOT NULL,
	"tin" text,
	CONSTRAINT "sale_beneficiaries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_beneficiaries_name_check" CHECK (length(trim("sale_beneficiaries"."name")) > 0 AND length(trim("sale_beneficiaries"."id_number")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"client_line_id" text NOT NULL,
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
	CONSTRAINT "sale_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_lines_number_unique" UNIQUE("tenant_id","sale_id","line_no"),
	CONSTRAINT "sale_lines_quantity_positive" CHECK ("sale_lines"."quantity" > 0),
	CONSTRAINT "sale_lines_beneficiary_share" CHECK (("sale_lines"."beneficiary_id" IS NULL) = ("sale_lines"."scheme_share" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "sale_tenders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"tendered" numeric(20, 4) NOT NULL,
	"change" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_tenders_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_tenders_method_check" CHECK ("sale_tenders"."method" IN ('CASH')),
	CONSTRAINT "sale_tenders_amounts_check" CHECK ("sale_tenders"."amount" >= 0 AND "sale_tenders"."change" >= 0 AND "sale_tenders"."tendered" - "sale_tenders"."change" = "sale_tenders"."amount")
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"cashier_session_id" uuid NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"client_transaction_id" text NOT NULL,
	"sale_number" bigint NOT NULL,
	"status" text DEFAULT 'COMPLETED' NOT NULL,
	"currency" char(3) NOT NULL,
	"tax_profile_id" uuid NOT NULL,
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
	"amount_tendered" numeric(20, 4) NOT NULL,
	"change_due" numeric(20, 4) NOT NULL,
	"requires_professional_review" boolean NOT NULL,
	"tax_snapshot" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sales_register_number_unique" UNIQUE("tenant_id","register_id","sale_number"),
	CONSTRAINT "sales_register_client_tx_unique" UNIQUE("tenant_id","register_id","client_transaction_id"),
	CONSTRAINT "sales_status_check" CHECK ("sales"."status" IN ('COMPLETED')),
	CONSTRAINT "sales_number_positive" CHECK ("sales"."sale_number" > 0),
	CONSTRAINT "sales_due_non_negative" CHECK ("sales"."amount_due" >= 0),
	CONSTRAINT "sales_tender_covers" CHECK ("sales"."amount_tendered" - "sales"."change_due" = "sales"."amount_due" AND "sales"."change_due" >= 0),
	CONSTRAINT "sales_buckets_check" CHECK ("sales"."amount_due" = "sales"."vatable_sales" + "sales"."vat_amount" + "sales"."vat_exempt_sales" + "sales"."zero_rated_sales" + "sales"."percentage_tax_sales" - "sales"."statutory_discount")
);
--> statement-breakpoint
CREATE TABLE "sequence_counters" (
	"tenant_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"name" text NOT NULL,
	"next_value" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "sequence_counters_tenant_id_scope_id_name_pk" PRIMARY KEY("tenant_id","scope_id","name"),
	CONSTRAINT "sequence_counters_positive" CHECK ("sequence_counters"."next_value" > 0)
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_tenant_id_branch_id_variant_id_pk" PRIMARY KEY("tenant_id","branch_id","variant_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"sale_id" uuid,
	"sale_line_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" IN ('SALE','ADJUSTMENT')),
	CONSTRAINT "stock_movements_nonzero" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_sale_link" CHECK (("stock_movements"."type" = 'SALE') = ("stock_movements"."sale_line_id" IS NOT NULL AND "stock_movements"."sale_id" IS NOT NULL)),
	CONSTRAINT "stock_movements_reason" CHECK ("stock_movements"."type" <> 'ADJUSTMENT' OR length(trim(coalesce("stock_movements"."reason", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_sessions" ADD CONSTRAINT "cashier_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cashier_sessions" ADD CONSTRAINT "cashier_sessions_tenant_id_branch_id_register_id_registers_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","register_id") REFERENCES "public"."registers"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_beneficiaries" ADD CONSTRAINT "sale_beneficiaries_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_price_id_product_prices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_id") REFERENCES "public"."product_prices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_beneficiary_id_sale_beneficiaries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","beneficiary_id") REFERENCES "public"."sale_beneficiaries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_branch_id_register_id_registers_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","register_id") REFERENCES "public"."registers"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_tax_profile_id_tax_profiles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","tax_profile_id") REFERENCES "public"."tax_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_counters" ADD CONSTRAINT "sequence_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_sale_line_id_sale_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_movements_session_idx" ON "cash_movements" USING btree ("tenant_id","cashier_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cashier_sessions_one_open_per_register" ON "cashier_sessions" USING btree ("tenant_id","register_id") WHERE "cashier_sessions"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "cashier_sessions_register_idx" ON "cashier_sessions" USING btree ("tenant_id","register_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sale_beneficiaries_sale_idx" ON "sale_beneficiaries" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_lines_sale_idx" ON "sale_lines" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "sale_tenders_sale_idx" ON "sale_tenders" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "sales_session_idx" ON "sales" USING btree ("tenant_id","cashier_session_id");--> statement-breakpoint
CREATE INDEX "sales_branch_time_idx" ON "sales" USING btree ("tenant_id","branch_id","completed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("tenant_id","branch_id","variant_id","created_at");--> statement-breakpoint
