CREATE TABLE "supplier_invoice_receipts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"matched_amount" numeric(20, 4) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_invoice_receipts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_invoice_receipts_pair_unique" UNIQUE("tenant_id","supplier_invoice_id","goods_receipt_id")
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"entry_number" bigint NOT NULL,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"net_amount" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"total_amount" numeric(20, 4) NOT NULL,
	"matched_amount" numeric(20, 4) NOT NULL,
	"input_vat" numeric(20, 4) NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "supplier_invoices_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_invoices_number_unique" UNIQUE("tenant_id","legal_entity_id","entry_number"),
	CONSTRAINT "supplier_invoices_status_check" CHECK ("supplier_invoices"."status" IN ('OPEN','CANCELLED')),
	CONSTRAINT "supplier_invoices_number_check" CHECK (length(trim("supplier_invoices"."invoice_number")) > 0),
	CONSTRAINT "supplier_invoices_amounts_check" CHECK ("supplier_invoices"."net_amount" >= 0 AND "supplier_invoices"."vat_amount" >= 0 AND "supplier_invoices"."total_amount" = "supplier_invoices"."net_amount" + "supplier_invoices"."vat_amount" AND "supplier_invoices"."input_vat" IN (0, "supplier_invoices"."vat_amount") AND "supplier_invoices"."matched_amount" >= 0),
	CONSTRAINT "supplier_invoices_due_check" CHECK ("supplier_invoices"."due_date" >= "supplier_invoices"."invoice_date"),
	CONSTRAINT "supplier_invoices_cancel_check" CHECK (("supplier_invoices"."status" = 'CANCELLED') = ("supplier_invoices"."cancelled_at" IS NOT NULL) AND ("supplier_invoices"."status" = 'OPEN' OR length(trim(coalesce("supplier_invoices"."cancel_reason", ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"payment_number" bigint NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"paid_on" date NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_payments_number_unique" UNIQUE("tenant_id","legal_entity_id","payment_number"),
	CONSTRAINT "supplier_payments_amount_check" CHECK ("supplier_payments"."amount" > 0),
	CONSTRAINT "supplier_payments_method_check" CHECK ("supplier_payments"."method" IN ('BANK_TRANSFER','CHECK','OTHER'))
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "supplier_invoice_receipts" ADD CONSTRAINT "supplier_invoice_receipts_tenant_id_supplier_invoice_id_supplier_invoices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_invoice_id") REFERENCES "public"."supplier_invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_receipts" ADD CONSTRAINT "supplier_invoice_receipts_tenant_id_goods_receipt_id_goods_receipts_tenant_id_id_fk" FOREIGN KEY ("tenant_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_supplier_id_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_supplier_id_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_supplier_invoice_id_supplier_invoices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_invoice_id") REFERENCES "public"."supplier_invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_receipts_active_unique" ON "supplier_invoice_receipts" USING btree ("tenant_id","goods_receipt_id") WHERE "supplier_invoice_receipts"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoices_supplier_ref_unique" ON "supplier_invoices" USING btree ("tenant_id","supplier_id",lower("invoice_number")) WHERE "supplier_invoices"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "supplier_invoices_supplier_idx" ON "supplier_invoices" USING btree ("tenant_id","supplier_id","status");--> statement-breakpoint
CREATE INDEX "supplier_invoices_due_idx" ON "supplier_invoices" USING btree ("tenant_id","legal_entity_id","due_date");--> statement-breakpoint
CREATE INDEX "supplier_payments_invoice_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_invoice_id");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','MANUAL','REVERSAL'));