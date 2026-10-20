CREATE TABLE "supplier_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entry_number" bigint NOT NULL,
	"note_number" text NOT NULL,
	"note_date" date NOT NULL,
	"net_amount" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"total_amount" numeric(20, 4) NOT NULL,
	"input_vat" numeric(20, 4) NOT NULL,
	"grni_cleared" numeric(20, 4) NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_notes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_notes_number_unique" UNIQUE("tenant_id","legal_entity_id","entry_number"),
	CONSTRAINT "supplier_notes_kind_check" CHECK ("supplier_notes"."kind" IN ('CREDIT','DEBIT')),
	CONSTRAINT "supplier_notes_text_check" CHECK (length(trim("supplier_notes"."note_number")) > 0 AND length(trim("supplier_notes"."reason")) > 0),
	CONSTRAINT "supplier_notes_amounts_check" CHECK ("supplier_notes"."net_amount" >= 0 AND "supplier_notes"."vat_amount" >= 0 AND "supplier_notes"."total_amount" = "supplier_notes"."net_amount" + "supplier_notes"."vat_amount" AND "supplier_notes"."total_amount" > 0 AND "supplier_notes"."input_vat" IN (0, "supplier_notes"."vat_amount") AND "supplier_notes"."grni_cleared" >= 0 AND ("supplier_notes"."kind" = 'CREDIT' OR "supplier_notes"."grni_cleared" = 0) AND "supplier_notes"."grni_cleared" <= "supplier_notes"."total_amount" - "supplier_notes"."input_vat")
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"supplier_payment_id" uuid NOT NULL,
	"supplier_invoice_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_payment_allocations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "supplier_payment_allocations_pair_unique" UNIQUE("tenant_id","supplier_payment_id","supplier_invoice_id"),
	CONSTRAINT "supplier_payment_allocations_amount_check" CHECK ("supplier_payment_allocations"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "supplier_payments" ALTER COLUMN "supplier_invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "supplier_notes" ADD CONSTRAINT "supplier_notes_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_notes" ADD CONSTRAINT "supplier_notes_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_notes" ADD CONSTRAINT "supplier_notes_tenant_id_supplier_id_suppliers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_id") REFERENCES "public"."suppliers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_notes" ADD CONSTRAINT "supplier_notes_tenant_id_supplier_invoice_id_supplier_invoices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_invoice_id") REFERENCES "public"."supplier_invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_tenant_id_supplier_payment_id_supplier_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_payment_id") REFERENCES "public"."supplier_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_tenant_id_supplier_invoice_id_supplier_invoices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","supplier_invoice_id") REFERENCES "public"."supplier_invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_notes_invoice_idx" ON "supplier_notes" USING btree ("tenant_id","supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_invoice_idx" ON "supplier_payment_allocations" USING btree ("tenant_id","supplier_invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_supplier_idx" ON "supplier_payments" USING btree ("tenant_id","supplier_id");--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_void_check" CHECK (("supplier_payments"."voided_at" IS NULL) = ("supplier_payments"."voided_by" IS NULL) AND ("supplier_payments"."voided_at" IS NULL) = ("supplier_payments"."void_reason" IS NULL) AND ("supplier_payments"."void_reason" IS NULL OR length(trim("supplier_payments"."void_reason")) > 0));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','SUPPLIER_NOTE','MANUAL','REVERSAL'));