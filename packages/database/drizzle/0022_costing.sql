ALTER TABLE "stock_balances" ADD COLUMN "value" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD COLUMN "avg_cost" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "unit_cost" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "value" numeric(20, 4) DEFAULT '0' NOT NULL;