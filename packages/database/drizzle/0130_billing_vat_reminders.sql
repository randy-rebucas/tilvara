ALTER TABLE "billing_bills" ADD COLUMN "vat_amount" numeric(20, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_bills" ADD COLUMN "reminded_early_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_bills" ADD COLUMN "reminded_last_at" timestamp with time zone;