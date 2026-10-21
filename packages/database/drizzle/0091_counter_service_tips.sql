CREATE TABLE "sale_tips" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"payment_intent_id" uuid,
	"amount" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_tips_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_tips_method_check" CHECK ("sale_tips"."method" IN ('CASH','CARD','QR','EWALLET')),
	CONSTRAINT "sale_tips_intent_check" CHECK (("sale_tips"."method" = 'CASH') = ("sale_tips"."payment_intent_id" IS NULL)),
	CONSTRAINT "sale_tips_amount_check" CHECK ("sale_tips"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_refund_link";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_reason_check";--> statement-breakpoint
ALTER TABLE "restaurant_orders" DROP CONSTRAINT "restaurant_orders_type_check";--> statement-breakpoint
ALTER TABLE "sale_returns" ADD COLUMN "tip_refund" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "print_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "print_claimed_by" uuid;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "print_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD COLUMN "sale_id" uuid;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "counter_service" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_tips" ADD CONSTRAINT "sale_tips_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tips" ADD CONSTRAINT "sale_tips_tenant_id_payment_intent_id_payment_intents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_tips_one_per_sale" ON "sale_tips" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_tips_intent_once" ON "sale_tips" USING btree ("tenant_id","payment_intent_id") WHERE "sale_tips"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_tenant_id_print_claimed_by_terminals_tenant_id_id_fk" FOREIGN KEY ("tenant_id","print_claimed_by") REFERENCES "public"."terminals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_tickets_unprinted_idx" ON "kitchen_tickets" USING btree ("tenant_id","branch_id","fired_at") WHERE "kitchen_tickets"."printed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "restaurant_orders_sale_unique" ON "restaurant_orders" USING btree ("tenant_id","sale_id") WHERE "restaurant_orders"."sale_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tip_link" CHECK ("cash_movements"."type" <> 'TIP' OR "cash_movements"."sale_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND','TIP','TIP_REFUND','TIP_PAYOUT'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND','TIP_REFUND','TIP_PAYOUT') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" IN ('PAY_IN','TIP') AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_refund_link" CHECK (("cash_movements"."type" IN ('REFUND','TIP_REFUND')) = ("cash_movements"."sale_return_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_reason_check" CHECK ("cash_movements"."type" NOT IN ('PAY_IN','PAY_OUT','TIP_PAYOUT') OR length(trim(coalesce("cash_movements"."reason", ''))) > 0);--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tip_refund_check" CHECK ("sale_returns"."tip_refund" >= 0 AND ("sale_returns"."tip_refund" = 0 OR "sale_returns"."kind" = 'VOID'));--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_print_claim_check" CHECK (("kitchen_tickets"."print_claimed_at" IS NULL) = ("kitchen_tickets"."print_claimed_by" IS NULL));--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_counter_sale_check" CHECK (("restaurant_orders"."order_type" = 'COUNTER') = ("restaurant_orders"."sale_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_type_check" CHECK ("restaurant_orders"."order_type" IN ('DINE_IN','TAKEAWAY','COUNTER'));