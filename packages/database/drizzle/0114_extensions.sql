CREATE TABLE "extensions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "extensions_code_format" CHECK ("extensions"."code" ~ '^[a-z][a-z0-9_]{1,39}$')
);
--> statement-breakpoint
CREATE TABLE "tenant_extensions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"extension_code" text NOT NULL,
	"enabled" boolean NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_extensions_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "tenant_extensions_code_unique" UNIQUE("tenant_id","extension_code")
);
--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "extensions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_extensions" ADD CONSTRAINT "tenant_extensions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_extensions" ADD CONSTRAINT "tenant_extensions_extension_code_extensions_code_fk" FOREIGN KEY ("extension_code") REFERENCES "public"."extensions"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_extensions" ADD CONSTRAINT "tenant_extensions_tenant_id_changed_by_tenant_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","changed_by") REFERENCES "public"."tenant_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;