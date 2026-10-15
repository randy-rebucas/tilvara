CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_intent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"detail" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_events_type_check" CHECK ("payment_events"."type" IN ('AUTHORIZE_REQUESTED','AUTHORIZED','DECLINED','TIMEOUT','RECONCILED','CANCEL_REQUESTED','CANCELED','CONSUMED'))
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"cashier_session_id" uuid NOT NULL,
	"client_transaction_id" text NOT NULL,
	"request_key" uuid NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"status" text DEFAULT 'PROCESSING' NOT NULL,
	"provider_reference" text,
	"failure_code" text,
	"sale_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_intents_request_key_unique" UNIQUE("tenant_id","request_key"),
	CONSTRAINT "payment_intents_status_check" CHECK ("payment_intents"."status" IN ('PROCESSING','SUCCEEDED','FAILED','UNKNOWN','CANCELED')),
	CONSTRAINT "payment_intents_method_check" CHECK ("payment_intents"."method" IN ('CARD','QR','EWALLET')),
	CONSTRAINT "payment_intents_amount_positive" CHECK ("payment_intents"."amount" > 0),
	CONSTRAINT "payment_intents_consumed_only_succeeded" CHECK ("payment_intents"."sale_id" IS NULL OR "payment_intents"."status" = 'SUCCEEDED')
);
--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD COLUMN "payment_intent_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_tenant_id_payment_intent_id_payment_intents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_branch_id_register_id_registers_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","register_id") REFERENCES "public"."registers"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_intent_idx" ON "payment_events" USING btree ("tenant_id","payment_intent_id");--> statement-breakpoint
CREATE INDEX "payment_intents_session_idx" ON "payment_intents" USING btree ("tenant_id","cashier_session_id","client_transaction_id");--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_tenant_id_payment_intent_id_payment_intents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_tenders_intent_once" ON "sale_tenders" USING btree ("tenant_id","payment_intent_id") WHERE "sale_tenders"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_intent_check" CHECK (("sale_tenders"."method" = 'CASH') = ("sale_tenders"."payment_intent_id" IS NULL));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_no_electronic_change" CHECK ("sale_tenders"."method" = 'CASH' OR "sale_tenders"."change" = 0);--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_method_check" CHECK ("sale_tenders"."method" IN ('CASH','CARD','QR','EWALLET'));