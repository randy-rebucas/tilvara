CREATE TABLE "held_carts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"cashier_session_id" uuid NOT NULL,
	"held_by" uuid NOT NULL,
	"label" text NOT NULL,
	"lines" jsonb NOT NULL,
	"beneficiaries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"line_count" integer NOT NULL,
	"amount_due" numeric(20, 4),
	"status" text DEFAULT 'OPEN' NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "held_carts_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "held_carts_status_check" CHECK ("held_carts"."status" IN ('OPEN','RESUMED','DISCARDED')),
	CONSTRAINT "held_carts_closed_check" CHECK (("held_carts"."status" = 'OPEN') = ("held_carts"."closed_at" IS NULL) AND ("held_carts"."closed_at" IS NULL) = ("held_carts"."closed_by" IS NULL)),
	CONSTRAINT "held_carts_label_check" CHECK (length(trim("held_carts"."label")) BETWEEN 1 AND 60),
	CONSTRAINT "held_carts_line_count_check" CHECK ("held_carts"."line_count" BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "price_overrides" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"list_unit_price" numeric(20, 4) NOT NULL,
	"unit_price" numeric(20, 4) NOT NULL,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approval_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "price_overrides_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "price_overrides_price_check" CHECK ("price_overrides"."unit_price" >= 0 AND "price_overrides"."list_unit_price" >= 0 AND "price_overrides"."unit_price" <> "price_overrides"."list_unit_price"),
	CONSTRAINT "price_overrides_reason_check" CHECK (length(trim("price_overrides"."reason")) > 0),
	CONSTRAINT "price_overrides_method_check" CHECK ("price_overrides"."approval_method" IN ('SELF','CREDENTIALS')),
	CONSTRAINT "price_overrides_self_check" CHECK (("price_overrides"."approval_method" = 'SELF') = ("price_overrides"."approved_by" = "price_overrides"."requested_by")),
	CONSTRAINT "price_overrides_expiry_check" CHECK ("price_overrides"."expires_at" > "price_overrides"."created_at")
);
--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "price_override_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD COLUMN "exchange_return_id" uuid;--> statement-breakpoint
ALTER TABLE "held_carts" ADD CONSTRAINT "held_carts_tenant_id_branch_id_register_id_registers_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","register_id") REFERENCES "public"."registers"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_carts" ADD CONSTRAINT "held_carts_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_tenant_id_price_id_product_prices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_id") REFERENCES "public"."product_prices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "held_carts_open_idx" ON "held_carts" USING btree ("tenant_id","register_id","created_at") WHERE "held_carts"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "price_overrides_branch_idx" ON "price_overrides" USING btree ("tenant_id","branch_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_price_override_id_price_overrides_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_override_id") REFERENCES "public"."price_overrides"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_tenant_id_exchange_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","exchange_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_lines_price_override_once" ON "sale_lines" USING btree ("tenant_id","price_override_id") WHERE "sale_lines"."price_override_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_tenders_exchange_once" ON "sale_tenders" USING btree ("tenant_id","exchange_return_id") WHERE "sale_tenders"."exchange_return_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_exchange_cash" CHECK ("sale_tenders"."exchange_return_id" IS NULL OR "sale_tenders"."method" = 'CASH');