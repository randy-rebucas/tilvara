CREATE TABLE "accounting_periods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_periods_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "accounting_periods_month_unique" UNIQUE("tenant_id","legal_entity_id","starts_on"),
	CONSTRAINT "accounting_periods_status_check" CHECK ("accounting_periods"."status" IN ('OPEN','CLOSED')),
	CONSTRAINT "accounting_periods_month_check" CHECK (extract(day FROM "accounting_periods"."starts_on") = 1)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"system_key" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "accounts_entity_id_unique" UNIQUE("tenant_id","legal_entity_id","id"),
	CONSTRAINT "accounts_code_unique" UNIQUE("tenant_id","legal_entity_id","code"),
	CONSTRAINT "accounts_type_check" CHECK ("accounts"."type" IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
	CONSTRAINT "accounts_name_check" CHECK (length(trim("accounts"."name")) > 0 AND length(trim("accounts"."code")) > 0)
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"entry_number" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"memo" text,
	"reverses_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "journal_entries_entity_id_unique" UNIQUE("tenant_id","legal_entity_id","id"),
	CONSTRAINT "journal_entries_number_unique" UNIQUE("tenant_id","legal_entity_id","entry_number"),
	CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','MANUAL','REVERSAL')),
	CONSTRAINT "journal_entries_manual_memo" CHECK ("journal_entries"."source_type" NOT IN ('MANUAL','REVERSAL') OR length(trim(coalesce("journal_entries"."memo", ''))) > 0),
	CONSTRAINT "journal_entries_reversal_link" CHECK (("journal_entries"."source_type" = 'REVERSAL') = ("journal_entries"."reverses_entry_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"debit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 4) DEFAULT '0' NOT NULL,
	"memo" text,
	CONSTRAINT "journal_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "journal_lines_amount_check" CHECK ("journal_lines"."debit" >= 0 AND "journal_lines"."credit" >= 0 AND ("journal_lines"."debit" = 0) <> ("journal_lines"."credit" = 0))
);
--> statement-breakpoint
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_tenant_id_legal_entity_id_reverses_entry_id_journal_entries_tenant_id_legal_entity_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id","reverses_entry_id") REFERENCES "public"."journal_entries"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_legal_entity_id_journal_entry_id_journal_entries_tenant_id_legal_entity_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id","journal_entry_id") REFERENCES "public"."journal_entries"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_legal_entity_id_account_id_accounts_tenant_id_legal_entity_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id","account_id") REFERENCES "public"."accounts"("tenant_id","legal_entity_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_system_key_unique" ON "accounts" USING btree ("tenant_id","legal_entity_id","system_key") WHERE "accounts"."system_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_source_unique" ON "journal_entries" USING btree ("tenant_id","source_type","source_id") WHERE "journal_entries"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_reversal_unique" ON "journal_entries" USING btree ("tenant_id","reverses_entry_id") WHERE "journal_entries"."reverses_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_entries_date_idx" ON "journal_entries" USING btree ("tenant_id","legal_entity_id","entry_date");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("tenant_id","journal_entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account_idx" ON "journal_lines" USING btree ("tenant_id","account_id");