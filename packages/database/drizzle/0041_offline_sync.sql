CREATE TABLE "terminal_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminal_snapshots_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "terminal_transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"terminal_id" uuid NOT NULL,
	"terminal_txn_id" uuid NOT NULL,
	"device_seq" bigint NOT NULL,
	"kind" text DEFAULT 'SALE' NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"cashier_session_id" uuid,
	"status" text NOT NULL,
	"sale_id" uuid,
	"error_code" text,
	"error_detail" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolve_reason" text,
	CONSTRAINT "terminal_transactions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "terminal_transactions_txn_unique" UNIQUE("tenant_id","terminal_id","terminal_txn_id"),
	CONSTRAINT "terminal_transactions_kind_check" CHECK ("terminal_transactions"."kind" IN ('SALE')),
	CONSTRAINT "terminal_transactions_status_check" CHECK ("terminal_transactions"."status" IN ('RECORDED','QUARANTINED','DISMISSED')),
	CONSTRAINT "terminal_transactions_recorded_has_sale" CHECK (("terminal_transactions"."status" = 'RECORDED') = ("terminal_transactions"."sale_id" IS NOT NULL)),
	CONSTRAINT "terminal_transactions_quarantine_has_code" CHECK ("terminal_transactions"."status" <> 'QUARANTINED' OR "terminal_transactions"."error_code" IS NOT NULL),
	CONSTRAINT "terminal_transactions_seq_positive" CHECK ("terminal_transactions"."device_seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "origin" text DEFAULT 'ONLINE' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "terminal_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "offline_reference" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "offline_flags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "terminal_snapshots" ADD CONSTRAINT "terminal_snapshots_tenant_id_terminal_id_terminals_tenant_id_id_fk" FOREIGN KEY ("tenant_id","terminal_id") REFERENCES "public"."terminals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_snapshots" ADD CONSTRAINT "terminal_snapshots_tenant_id_register_id_registers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_transactions" ADD CONSTRAINT "terminal_transactions_tenant_id_terminal_id_terminals_tenant_id_id_fk" FOREIGN KEY ("tenant_id","terminal_id") REFERENCES "public"."terminals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_transactions" ADD CONSTRAINT "terminal_transactions_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_transactions" ADD CONSTRAINT "terminal_transactions_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terminal_snapshots_terminal_idx" ON "terminal_snapshots" USING btree ("tenant_id","terminal_id","as_of" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "terminal_transactions_status_idx" ON "terminal_transactions" USING btree ("tenant_id","status","received_at");--> statement-breakpoint
CREATE INDEX "terminal_transactions_session_idx" ON "terminal_transactions" USING btree ("tenant_id","cashier_session_id");--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_terminal_id_terminals_tenant_id_id_fk" FOREIGN KEY ("tenant_id","terminal_id") REFERENCES "public"."terminals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_origin_check" CHECK (("sales"."origin" = 'ONLINE' AND "sales"."terminal_id" IS NULL AND "sales"."offline_reference" IS NULL) OR ("sales"."origin" = 'OFFLINE' AND "sales"."terminal_id" IS NOT NULL AND "sales"."offline_reference" IS NOT NULL));