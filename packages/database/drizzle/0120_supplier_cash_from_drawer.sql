-- A supplier paid in cash from a till's drawer (session 36, retail fit audit): the payment (method CASH_DRAWER), a
-- SUPPLIER_PAYMENT drawer movement naming it (negative) and one entry (Dr payables, Cr cash on hand) in one transaction.
-- Voiding the payment puts the cash back into an open drawer (a positive SUPPLIER_PAYMENT movement, at most one).
-- The type and sign checks stay NOT VALID as before (0113): drawer movements of removed features (FOLIO_PAYMENT,
-- JOB_DEPOSIT, DEPOSIT) stay as history. The grants on cash_movements are table-wide (no new grant needed).
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "supplier_payments" DROP CONSTRAINT "supplier_payments_method_check";--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "supplier_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_supplier_payment_id_supplier_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_payment_id") REFERENCES "public"."supplier_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_movements_supplier_payment_unique" ON "cash_movements" USING btree ("tenant_id","supplier_payment_id",("amount" > 0)) WHERE "cash_movements"."supplier_payment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_supplier_payment_link" CHECK (("cash_movements"."type" = 'SUPPLIER_PAYMENT') = ("cash_movements"."supplier_payment_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND','SUPPLIER_PAYMENT')) NOT VALID;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" = 'PAY_IN' AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0) OR ("cash_movements"."type" = 'SUPPLIER_PAYMENT' AND "cash_movements"."amount" <> 0)) NOT VALID;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_method_check" CHECK ("supplier_payments"."method" IN ('BANK_TRANSFER','CHECK','OTHER','CASH_DRAWER'));