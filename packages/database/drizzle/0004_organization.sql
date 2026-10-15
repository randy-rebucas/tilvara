CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"bir_branch_code" char(5) DEFAULT '00000' NOT NULL,
	"address" text,
	"timezone" text DEFAULT 'Asia/Manila' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "branches_tenant_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "branches_entity_bir_code_unique" UNIQUE("tenant_id","legal_entity_id","bir_branch_code"),
	CONSTRAINT "branches_code_format" CHECK ("branches"."code" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
	CONSTRAINT "branches_bir_code_format" CHECK ("branches"."bir_branch_code" ~ '^[0-9]{5}$')
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"registered_name" text NOT NULL,
	"trade_name" text,
	"tin" char(9),
	"vat_status" text NOT NULL,
	"registered_address" text,
	"rdo_code" text,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"price_display" text DEFAULT 'TAX_INCLUSIVE' NOT NULL,
	"rounding_mode" text DEFAULT 'HALF_UP' NOT NULL,
	"invoicing_mode" text DEFAULT 'DISABLED' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_entities_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "legal_entities_tin_format" CHECK ("legal_entities"."tin" IS NULL OR "legal_entities"."tin" ~ '^[0-9]{9}$'),
	CONSTRAINT "legal_entities_vat_status_check" CHECK ("legal_entities"."vat_status" IN ('VAT','NON_VAT')),
	CONSTRAINT "legal_entities_price_display_check" CHECK ("legal_entities"."price_display" IN ('TAX_INCLUSIVE','TAX_EXCLUSIVE')),
	CONSTRAINT "legal_entities_rounding_check" CHECK ("legal_entities"."rounding_mode" IN ('HALF_UP','HALF_EVEN')),
	CONSTRAINT "legal_entities_invoicing_mode_check" CHECK ("legal_entities"."invoicing_mode" IN ('DISABLED','DEV_SERIES'))
);
--> statement-breakpoint
CREATE TABLE "registers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registers_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "registers_branch_code_unique" UNIQUE("tenant_id","branch_id","code"),
	CONSTRAINT "registers_code_format" CHECK ("registers"."code" ~ '^[A-Z0-9][A-Z0-9-]{0,19}$')
);
--> statement-breakpoint
CREATE TABLE "terminals" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"credential_hash" text NOT NULL,
	"credential_hint" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "terminals_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "terminals_credential_hash_unique" UNIQUE("credential_hash"),
	CONSTRAINT "terminals_status_check" CHECK ("terminals"."status" IN ('ACTIVE','REVOKED')),
	CONSTRAINT "terminals_revoked_consistency" CHECK (("terminals"."status" = 'REVOKED') = ("terminals"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registers" ADD CONSTRAINT "registers_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_tenant_id_register_id_registers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","register_id") REFERENCES "public"."registers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_tenant_tin_unique" ON "legal_entities" USING btree ("tenant_id","tin") WHERE "legal_entities"."tin" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "terminals_register_idx" ON "terminals" USING btree ("tenant_id","register_id");