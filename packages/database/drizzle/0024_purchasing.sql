CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"purchase_order_line_id" uuid,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"rejected_quantity" numeric(18, 4) DEFAULT '0' NOT NULL,
	"rejection_reason" text,
	"unit_cost" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipt_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "goods_receipt_lines_quantity_check" CHECK ("goods_receipt_lines"."quantity" >= 0 AND "goods_receipt_lines"."rejected_quantity" >= 0 AND "goods_receipt_lines"."quantity" + "goods_receipt_lines"."rejected_quantity" > 0),
	CONSTRAINT "goods_receipt_lines_rejection_check" CHECK ("goods_receipt_lines"."rejected_quantity" = 0 OR length(trim(coalesce("goods_receipt_lines"."rejection_reason", ''))) > 0),
	CONSTRAINT "goods_receipt_lines_cost_check" CHECK ("goods_receipt_lines"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"receipt_number" bigint NOT NULL,
	"supplier_invoice_ref" text,
	"supplier_delivery_ref" text,
	"notes" text,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "goods_receipts_number_unique" UNIQUE("tenant_id","branch_id","receipt_number")
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_order_lines_line_unique" UNIQUE("tenant_id","purchase_order_id","line_no"),
	CONSTRAINT "purchase_order_lines_quantity_check" CHECK ("purchase_order_lines"."quantity" > 0),
	CONSTRAINT "purchase_order_lines_cost_check" CHECK ("purchase_order_lines"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"po_number" bigint NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"expected_on" date,
	"supplier_ref" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"ended_by" uuid,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "purchase_orders_number_unique" UNIQUE("tenant_id","branch_id","po_number"),
	CONSTRAINT "purchase_orders_status_check" CHECK ("purchase_orders"."status" IN ('DRAFT','APPROVED','PARTIALLY_RECEIVED','RECEIVED','CLOSED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "supplier_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_return_id" uuid NOT NULL,
	"goods_receipt_line_id" uuid,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"credit_unit_cost" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_return_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_return_lines_quantity_check" CHECK ("supplier_return_lines"."quantity" > 0),
	CONSTRAINT "supplier_return_lines_cost_check" CHECK ("supplier_return_lines"."credit_unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_returns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"goods_receipt_id" uuid,
	"return_number" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_returns_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_returns_number_unique" UNIQUE("tenant_id","branch_id","return_number"),
	CONSTRAINT "supplier_returns_reason_check" CHECK (length(trim("supplier_returns"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"tin" text,
	"email" text,
	"phone" text,
	"address" text,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "suppliers_name_check" CHECK (length(trim("suppliers"."name")) > 0),
	CONSTRAINT "suppliers_terms_check" CHECK ("suppliers"."payment_terms_days" BETWEEN 0 AND 365)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_check";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_direction";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "goods_receipt_line_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "supplier_return_line_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_tenant_id_goods_receipt_id_goods_receipts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_tenant_id_purchase_order_line_id_purchase_order_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenant_id_supplier_id_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_tenant_id_purchase_order_id_purchase_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_purchase_order_id_purchase_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","purchase_order_id") REFERENCES "public"."purchase_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_supplier_id_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_tenant_id_supplier_return_id_supplier_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_return_id") REFERENCES "public"."supplier_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_tenant_id_goods_receipt_line_id_goods_receipt_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_tenant_id_supplier_id_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_tenant_id_goods_receipt_id_goods_receipts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_po_line_idx" ON "goods_receipt_lines" USING btree ("tenant_id","purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_po_idx" ON "goods_receipts" USING btree ("tenant_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_branch_idx" ON "purchase_orders" USING btree ("tenant_id","branch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_code_active_unique" ON "suppliers" USING btree ("tenant_id",lower("code")) WHERE "suppliers"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_goods_receipt_line_id_goods_receipt_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","goods_receipt_line_id") REFERENCES "public"."goods_receipt_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_supplier_return_line_id_supplier_return_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_return_line_id") REFERENCES "public"."supplier_return_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_receipt_link" CHECK (("stock_movements"."type" = 'RECEIPT') = ("stock_movements"."goods_receipt_line_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_supplier_return_link" CHECK (("stock_movements"."type" = 'SUPPLIER_RETURN') = ("stock_movements"."supplier_return_line_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_check" CHECK ("stock_movements"."type" IN ('SALE','ADJUSTMENT','RETURN','RECEIPT','SUPPLIER_RETURN'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_direction" CHECK (("stock_movements"."type" IN ('SALE','SUPPLIER_RETURN') AND "stock_movements"."quantity" < 0) OR ("stock_movements"."type" IN ('RETURN','RECEIPT') AND "stock_movements"."quantity" > 0) OR "stock_movements"."type" = 'ADJUSTMENT');