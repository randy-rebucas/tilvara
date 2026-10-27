-- A return to the supplier names the expiry lot it leaves from (retail fit audit, second pass): a recalled or
-- expired batch goes back from its own lot (by default the lot its goods receipt line made), so the lot no longer
-- shows on hand and no longer holds back good stock at the counter. The lot trigger draws a named lot for any type.
-- Only the check changes; no data is touched.
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_named_lot";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_named_lot" CHECK ("stock_movements"."lot_id" IS NULL OR ("stock_movements"."quantity" < 0 AND "stock_movements"."type" IN ('ADJUSTMENT','WASTE','SUPPLIER_RETURN')));