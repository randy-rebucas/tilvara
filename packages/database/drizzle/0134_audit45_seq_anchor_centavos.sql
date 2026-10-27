ALTER TABLE "subscriptions" ADD COLUMN "billing_anchor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD COLUMN "movement_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "balance_seq" bigint;--> statement-breakpoint
ALTER TABLE "stock_count_sheet_lines" ADD COLUMN "frozen_seq" bigint;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_centavos" CHECK ("cash_movements"."amount" = round("cash_movements"."amount", 2));--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_centavos" CHECK ("customer_credit_entries"."amount" = round("customer_credit_entries"."amount", 2));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_centavos" CHECK ("payment_intents"."amount" = round("payment_intents"."amount", 2));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_centavos" CHECK ("sale_tenders"."amount" = round("sale_tenders"."amount", 2) AND "sale_tenders"."tendered" = round("sale_tenders"."tendered", 2) AND "sale_tenders"."change" = round("sale_tenders"."change", 2));