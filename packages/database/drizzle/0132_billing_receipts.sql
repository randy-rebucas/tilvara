CREATE TABLE "billing_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"number" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"vatable_amount" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"method" text NOT NULL,
	"reference" text NOT NULL,
	CONSTRAINT "billing_receipts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_receipts_number_unique" UNIQUE("number"),
	CONSTRAINT "billing_receipts_payment_unique" UNIQUE("payment_id"),
	CONSTRAINT "billing_receipts_amounts_check" CHECK ("billing_receipts"."amount" > 0 AND "billing_receipts"."vatable_amount" + "billing_receipts"."vat_amount" = "billing_receipts"."amount")
);
--> statement-breakpoint
CREATE TABLE "billing_seller" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"registered_name" text NOT NULL,
	"trade_name" text,
	"tin" text,
	"address" text,
	"vat_registered" boolean DEFAULT true NOT NULL,
	"permit_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_seller_one_row" CHECK ("billing_seller"."id")
);
--> statement-breakpoint
ALTER TABLE "billing_receipts" ADD CONSTRAINT "billing_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_receipts" ADD CONSTRAINT "billing_receipts_tenant_id_bill_id_billing_bills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."billing_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_receipts" ADD CONSTRAINT "billing_receipts_tenant_id_payment_id_billing_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."billing_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_receipts_tenant_idx" ON "billing_receipts" USING btree ("tenant_id","issued_at" DESC NULLS LAST);