CREATE TABLE "sale_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_return_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"disposition" text NOT NULL,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	CONSTRAINT "sale_return_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_return_lines_once_per_return" UNIQUE("tenant_id","sale_return_id","sale_line_id"),
	CONSTRAINT "sale_return_lines_quantity_positive" CHECK ("sale_return_lines"."quantity" > 0),
	CONSTRAINT "sale_return_lines_disposition_check" CHECK ("sale_return_lines"."disposition" IN ('RESTOCK','DAMAGED'))
);
--> statement-breakpoint
CREATE TABLE "sale_returns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"cashier_session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"return_number" bigint NOT NULL,
	"reason" text NOT NULL,
	"processed_by" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	"refund_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_returns_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "sale_returns_register_number_unique" UNIQUE("tenant_id","register_id","return_number"),
	CONSTRAINT "sale_returns_kind_check" CHECK ("sale_returns"."kind" IN ('VOID','RETURN')),
	CONSTRAINT "sale_returns_reason_check" CHECK (length(trim("sale_returns"."reason")) > 0),
	CONSTRAINT "sale_returns_refund_method_check" CHECK ("sale_returns"."refund_method" IN ('CASH')),
	CONSTRAINT "sale_returns_buckets_check" CHECK ("sale_returns"."amount_due" = "sale_returns"."vatable_sales" + "sale_returns"."vat_amount" + "sale_returns"."vat_exempt_sales" + "sale_returns"."zero_rated_sales" + "sale_returns"."percentage_tax_sales" - "sale_returns"."statutory_discount")
);
--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_sale_link";--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "sale_return_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "sale_return_line_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_tenant_id_sale_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_return_lines" ADD CONSTRAINT "sale_return_lines_tenant_id_sale_line_id_sale_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_branch_id_register_id_registers_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","register_id") REFERENCES "public"."registers"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_return_lines_line_idx" ON "sale_return_lines" USING btree ("tenant_id","sale_line_id");--> statement-breakpoint
CREATE INDEX "sale_returns_sale_idx" ON "sale_returns" USING btree ("tenant_id","sale_id");--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_sale_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_sale_return_line_id_sale_return_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_line_id") REFERENCES "public"."sale_return_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_refund_link" CHECK (("cash_movements"."type" = 'REFUND') = ("cash_movements"."sale_return_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" IN ('PAY_IN') AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_return_link" CHECK (("stock_movements"."type" = 'RETURN') = ("stock_movements"."sale_return_line_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_direction" CHECK (("stock_movements"."type" = 'SALE' AND "stock_movements"."quantity" < 0) OR ("stock_movements"."type" = 'RETURN' AND "stock_movements"."quantity" > 0) OR "stock_movements"."type" = 'ADJUSTMENT');--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" IN ('SALE','ADJUSTMENT','RETURN'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sale_link" CHECK (("stock_movements"."type" IN ('SALE','RETURN')) = ("stock_movements"."sale_line_id" IS NOT NULL AND "stock_movements"."sale_id" IS NOT NULL));