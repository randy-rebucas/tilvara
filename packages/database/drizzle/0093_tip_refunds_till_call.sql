CREATE TABLE "sale_tip_refunds" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_return_id" uuid NOT NULL,
	"sale_tip_id" uuid NOT NULL,
	"method" text NOT NULL,
	"payment_intent_id" uuid,
	"amount" numeric(20, 4) NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_tip_refunds_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_tip_refunds_method_check" CHECK ("sale_tip_refunds"."method" IN ('CARD','CASH')),
	CONSTRAINT "sale_tip_refunds_intent_check" CHECK (("sale_tip_refunds"."method" = 'CARD') = ("sale_tip_refunds"."payment_intent_id" IS NOT NULL)),
	CONSTRAINT "sale_tip_refunds_amount_check" CHECK ("sale_tip_refunds"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_consumed_only_succeeded";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "purpose" text DEFAULT 'SALE' NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD COLUMN "till_call_number" integer;--> statement-breakpoint
ALTER TABLE "sale_tip_refunds" ADD CONSTRAINT "sale_tip_refunds_tenant_id_sale_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tip_refunds" ADD CONSTRAINT "sale_tip_refunds_tenant_id_sale_tip_id_sale_tips_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_tip_id") REFERENCES "public"."sale_tips"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tip_refunds" ADD CONSTRAINT "sale_tip_refunds_tenant_id_payment_intent_id_payment_intents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_tip_refunds_one_per_void" ON "sale_tip_refunds" USING btree ("tenant_id","sale_return_id");--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" IN ('SALE','TIP'));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_consumed_only_succeeded" CHECK ("payment_intents"."sale_id" IS NULL OR "payment_intents"."status" = 'SUCCEEDED' OR ("payment_intents"."purpose" = 'TIP' AND "payment_intents"."status" = 'CANCELED'));--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_till_call_check" CHECK ("restaurant_orders"."till_call_number" IS NULL OR ("restaurant_orders"."order_type" = 'COUNTER' AND "restaurant_orders"."till_call_number" > 0));