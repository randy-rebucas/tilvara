CREATE TABLE "customer_consent_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"purpose" text DEFAULT 'MARKETING' NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_consent_events_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_consent_events_purpose_check" CHECK ("customer_consent_events"."purpose" IN ('MARKETING')),
	CONSTRAINT "customer_consent_events_source_check" CHECK ("customer_consent_events"."source" IN ('COUNTER','ADMIN','REQUEST'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text,
	"display_name" text NOT NULL,
	"phone" text,
	"email" text,
	"tin" text,
	"address" text,
	"notes" text,
	"marketing_consent" boolean DEFAULT false NOT NULL,
	"marketing_consent_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"anonymised_at" timestamp with time zone,
	CONSTRAINT "customers_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customers_name_check" CHECK (length(trim("customers"."display_name")) BETWEEN 1 AND 200),
	CONSTRAINT "customers_consent_check" CHECK (("customers"."marketing_consent") = ("customers"."marketing_consent_at" IS NOT NULL)),
	CONSTRAINT "customers_anonymised_check" CHECK ("customers"."anonymised_at" IS NULL OR ("customers"."phone" IS NULL AND "customers"."email" IS NULL AND "customers"."tin" IS NULL AND "customers"."address" IS NULL AND "customers"."notes" IS NULL AND "customers"."code" IS NULL AND NOT "customers"."marketing_consent" AND "customers"."archived_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "customer_credit_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"sale_id" uuid,
	"sale_return_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_entries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_credit_entries_kind_check" CHECK ("customer_credit_entries"."kind" IN ('RETURN','REDEEM')),
	CONSTRAINT "customer_credit_entries_link_check" CHECK (("customer_credit_entries"."kind" = 'RETURN' AND "customer_credit_entries"."amount" > 0 AND "customer_credit_entries"."sale_return_id" IS NOT NULL AND "customer_credit_entries"."sale_id" IS NULL) OR ("customer_credit_entries"."kind" = 'REDEEM' AND "customer_credit_entries"."amount" < 0 AND "customer_credit_entries"."sale_id" IS NOT NULL AND "customer_credit_entries"."sale_return_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sale_returns" DROP CONSTRAINT "sale_returns_refund_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_intent_check";--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_consent_events" ADD CONSTRAINT "customer_consent_events_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_tenant_id_sale_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_consent_events_customer_idx" ON "customer_consent_events" USING btree ("tenant_id","customer_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_code_active_unique" ON "customers" USING btree ("tenant_id",lower("code")) WHERE "customers"."archived_at" IS NULL AND "customers"."code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("tenant_id",lower("display_name"));--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("tenant_id","phone");--> statement-breakpoint
CREATE INDEX "customer_credit_entries_customer_idx" ON "customer_credit_entries" USING btree ("tenant_id","customer_id","legal_entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_entries_return_once" ON "customer_credit_entries" USING btree ("tenant_id","sale_return_id") WHERE "customer_credit_entries"."sale_return_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_entries_sale_once" ON "customer_credit_entries" USING btree ("tenant_id","sale_id") WHERE "customer_credit_entries"."sale_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_customer_idx" ON "sales" USING btree ("tenant_id","customer_id","completed_at" DESC NULLS LAST) WHERE "sales"."customer_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_refund_method_check" CHECK ("sale_returns"."refund_method" IN ('CASH','STORE_CREDIT'));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_method_check" CHECK ("sale_tenders"."method" IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT'));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_intent_check" CHECK (("sale_tenders"."method" IN ('CASH','STORE_CREDIT')) = ("sale_tenders"."payment_intent_id" IS NULL));