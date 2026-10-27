CREATE TABLE "billing_bills" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"plan_code" text NOT NULL,
	"from_plan_code" text,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	CONSTRAINT "billing_bills_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_bills_tenant_number_unique" UNIQUE("tenant_id","number"),
	CONSTRAINT "billing_bills_kind_check" CHECK ("billing_bills"."kind" IN ('START','RENEWAL','UPGRADE')),
	CONSTRAINT "billing_bills_status_check" CHECK ("billing_bills"."status" IN ('OPEN','PAID','VOID')),
	CONSTRAINT "billing_bills_amount_check" CHECK ("billing_bills"."amount" > 0),
	CONSTRAINT "billing_bills_period_check" CHECK ("billing_bills"."period_end" > "billing_bills"."period_start"),
	CONSTRAINT "billing_bills_upgrade_check" CHECK (("billing_bills"."kind" = 'UPGRADE') = ("billing_bills"."from_plan_code" IS NOT NULL)),
	CONSTRAINT "billing_bills_status_dates_check" CHECK (("billing_bills"."status" = 'PAID') = ("billing_bills"."paid_at" IS NOT NULL) AND ("billing_bills"."status" = 'VOID') = ("billing_bills"."voided_at" IS NOT NULL AND "billing_bills"."void_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "billing_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_checkout_id" text NOT NULL,
	"checkout_url" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "billing_checkouts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_checkouts_provider_id_unique" UNIQUE("provider","provider_checkout_id"),
	CONSTRAINT "billing_checkouts_provider_check" CHECK ("billing_checkouts"."provider" IN ('PAYMONGO','DEV')),
	CONSTRAINT "billing_checkouts_status_check" CHECK ("billing_checkouts"."status" IN ('OPEN','PAID','EXPIRED'))
);
--> statement-breakpoint
CREATE TABLE "billing_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" text NOT NULL,
	"method" text NOT NULL,
	"provider" text NOT NULL,
	"reference" text NOT NULL,
	"applied" boolean NOT NULL,
	"recorded_by" text NOT NULL,
	"note" text,
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_payments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "billing_payments_reference_unique" UNIQUE("tenant_id","provider","reference"),
	CONSTRAINT "billing_payments_amount_check" CHECK ("billing_payments"."amount" > 0),
	CONSTRAINT "billing_payments_method_check" CHECK ("billing_payments"."method" IN ('BANK_TRANSFER','CARD','GCASH','MAYA','GRABPAY','QRPH','CASH','OTHER')),
	CONSTRAINT "billing_payments_provider_check" CHECK ("billing_payments"."provider" IN ('MANUAL','PAYMONGO','DEV'))
);
--> statement-breakpoint
CREATE TABLE "billing_provider_events" (
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_provider_events_provider_event_id_pk" PRIMARY KEY("provider","event_id")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "scheduled_plan_code" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_bills" ADD CONSTRAINT "billing_bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_bills" ADD CONSTRAINT "billing_bills_plan_code_plans_code_fk" FOREIGN KEY ("plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_bills" ADD CONSTRAINT "billing_bills_from_plan_code_plans_code_fk" FOREIGN KEY ("from_plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_tenant_id_bill_id_billing_bills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."billing_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_tenant_id_created_by_tenant_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."tenant_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_tenant_id_bill_id_billing_bills_tenant_id_id_fk" FOREIGN KEY ("tenant_id","bill_id") REFERENCES "public"."billing_bills"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_bills_one_open_period" ON "billing_bills" USING btree ("tenant_id") WHERE "billing_bills"."status" = 'OPEN' AND "billing_bills"."kind" <> 'UPGRADE';--> statement-breakpoint
CREATE UNIQUE INDEX "billing_bills_one_open_upgrade" ON "billing_bills" USING btree ("tenant_id") WHERE "billing_bills"."status" = 'OPEN' AND "billing_bills"."kind" = 'UPGRADE';--> statement-breakpoint
CREATE INDEX "billing_bills_tenant_issued_idx" ON "billing_bills" USING btree ("tenant_id","issued_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "billing_checkouts_bill_idx" ON "billing_checkouts" USING btree ("tenant_id","bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_payments_provider_reference" ON "billing_payments" USING btree ("provider","reference") WHERE "billing_payments"."provider" <> 'MANUAL';--> statement-breakpoint
CREATE INDEX "billing_payments_bill_idx" ON "billing_payments" USING btree ("tenant_id","bill_id");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_scheduled_plan_code_plans_code_fk" FOREIGN KEY ("scheduled_plan_code") REFERENCES "public"."plans"("code") ON DELETE no action ON UPDATE no action;