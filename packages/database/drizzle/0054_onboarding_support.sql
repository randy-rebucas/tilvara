CREATE TABLE "data_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"file_key" text,
	"size_bytes" bigint,
	"sha256" text,
	"row_counts" jsonb,
	"expires_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "data_exports_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "data_exports_status_check" CHECK ("data_exports"."status" IN ('REQUESTED','READY','FAILED','EXPIRED')),
	CONSTRAINT "data_exports_ready_has_file" CHECK ("data_exports"."status" <> 'READY' OR ("data_exports"."file_key" IS NOT NULL AND "data_exports"."sha256" IS NOT NULL AND "data_exports"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_staff" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"added_by" text NOT NULL,
	"added_reason" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_by" text,
	"disabled_reason" text,
	CONSTRAINT "platform_staff_status_check" CHECK ("platform_staff"."status" IN ('ACTIVE','DISABLED')),
	CONSTRAINT "platform_staff_disabled_consistent" CHECK (("platform_staff"."status" = 'DISABLED') = ("platform_staff"."disabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "support_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"ticket_ref" text,
	"access" text DEFAULT 'READ_ONLY' NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	CONSTRAINT "support_grants_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_grants_access_check" CHECK ("support_grants"."access" IN ('READ_ONLY')),
	CONSTRAINT "support_grants_purpose_present" CHECK (length(btrim("support_grants"."purpose")) >= 5),
	CONSTRAINT "support_grants_window" CHECK ("support_grants"."expires_at" > "support_grants"."granted_at" AND "support_grants"."expires_at" <= "support_grants"."granted_at" + interval '72 hours'),
	CONSTRAINT "support_grants_revoked_consistent" CHECK (("support_grants"."revoked_at" IS NULL) = ("support_grants"."revoked_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_sample" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "data_exports" ADD CONSTRAINT "data_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_staff" ADD CONSTRAINT "platform_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_exports_tenant_idx" ON "data_exports" USING btree ("tenant_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "data_exports_one_requested" ON "data_exports" USING btree ("tenant_id") WHERE "data_exports"."status" = 'REQUESTED';--> statement-breakpoint
CREATE INDEX "data_exports_ready_idx" ON "data_exports" USING btree ("expires_at") WHERE "data_exports"."status" = 'READY';--> statement-breakpoint
CREATE INDEX "support_grants_tenant_idx" ON "support_grants" USING btree ("tenant_id","granted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_grants_open_idx" ON "support_grants" USING btree ("expires_at") WHERE "support_grants"."revoked_at" IS NULL;