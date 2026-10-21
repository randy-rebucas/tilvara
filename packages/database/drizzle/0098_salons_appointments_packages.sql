CREATE TABLE "appointment_services" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "appointment_services_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointment_services_position_unique" UNIQUE("tenant_id","appointment_id","position"),
	CONSTRAINT "appointment_services_span_check" CHECK ("appointment_services"."ends_at" > "appointment_services"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid,
	"guest_name" text,
	"status" text DEFAULT 'BOOKED' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"notes" text,
	"remind" boolean DEFAULT false NOT NULL,
	"reminded_at" timestamp with time zone,
	"sale_id" uuid,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "appointments_status_check" CHECK ("appointments"."status" IN ('BOOKED','ARRIVED','COMPLETED','NO_SHOW','CANCELLED')),
	CONSTRAINT "appointments_who_check" CHECK ("appointments"."customer_id" IS NOT NULL OR length(btrim(coalesce("appointments"."guest_name", ''))) BETWEEN 1 AND 120),
	CONSTRAINT "appointments_guest_name_check" CHECK ("appointments"."guest_name" IS NULL OR length("appointments"."guest_name") <= 120),
	CONSTRAINT "appointments_span_check" CHECK ("appointments"."ends_at" > "appointments"."starts_at"),
	CONSTRAINT "appointments_sale_check" CHECK (("appointments"."status" = 'COMPLETED') = ("appointments"."sale_id" IS NOT NULL)),
	CONSTRAINT "appointments_notes_check" CHECK ("appointments"."notes" IS NULL OR length("appointments"."notes") <= 500),
	CONSTRAINT "appointments_cancel_check" CHECK ("appointments"."cancel_reason" IS NULL OR length("appointments"."cancel_reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"body" text NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_notes_body_check" CHECK (length(btrim("customer_notes"."body")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "customer_package_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_package_id" uuid NOT NULL,
	"customer_package_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sessions" integer NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"sale_id" uuid,
	"sale_line_id" uuid,
	"sale_return_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_package_entries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_package_entries_kind_check" CHECK ("customer_package_entries"."kind" IN ('SOLD','REDEEMED','RESTORED','REFUNDED')),
	CONSTRAINT "customer_package_entries_sign_check" CHECK (CASE WHEN "customer_package_entries"."kind" IN ('SOLD','RESTORED') THEN "customer_package_entries"."sessions" > 0 AND "customer_package_entries"."value" >= 0 ELSE "customer_package_entries"."sessions" < 0 AND "customer_package_entries"."value" <= 0 END),
	CONSTRAINT "customer_package_entries_link_check" CHECK (CASE "customer_package_entries"."kind" WHEN 'SOLD' THEN "customer_package_entries"."sale_line_id" IS NOT NULL AND "customer_package_entries"."sale_return_id" IS NULL
                         WHEN 'REDEEMED' THEN "customer_package_entries"."sale_line_id" IS NOT NULL AND "customer_package_entries"."sale_return_id" IS NULL
                         ELSE "customer_package_entries"."sale_return_id" IS NOT NULL END)
);
--> statement-breakpoint
CREATE TABLE "customer_package_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_package_id" uuid NOT NULL,
	"service_variant_id" uuid NOT NULL,
	"sessions" integer NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	CONSTRAINT "customer_package_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_package_items_service_unique" UNIQUE("tenant_id","customer_package_id","service_variant_id"),
	CONSTRAINT "customer_package_items_sessions_check" CHECK ("customer_package_items"."sessions" >= 1),
	CONSTRAINT "customer_package_items_value_check" CHECK ("customer_package_items"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_packages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"package_variant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"unit_no" integer NOT NULL,
	"value" numeric(20, 4) NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_packages_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_packages_unit_unique" UNIQUE("tenant_id","sale_line_id","unit_no"),
	CONSTRAINT "customer_packages_unit_check" CHECK ("customer_packages"."unit_no" >= 1),
	CONSTRAINT "customer_packages_value_check" CHECK ("customer_packages"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sale_tip_shares" (
	"tenant_id" uuid NOT NULL,
	"sale_tip_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	CONSTRAINT "sale_tip_shares_tenant_id_sale_tip_id_staff_id_pk" PRIMARY KEY("tenant_id","sale_tip_id","staff_id"),
	CONSTRAINT "sale_tip_shares_amount_check" CHECK ("sale_tip_shares"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "service_package_items" (
	"tenant_id" uuid NOT NULL,
	"package_variant_id" uuid NOT NULL,
	"service_variant_id" uuid NOT NULL,
	"sessions" integer NOT NULL,
	CONSTRAINT "service_package_items_tenant_id_package_variant_id_service_variant_id_pk" PRIMARY KEY("tenant_id","package_variant_id","service_variant_id"),
	CONSTRAINT "service_package_items_sessions_check" CHECK ("service_package_items"."sessions" BETWEEN 1 AND 1000),
	CONSTRAINT "service_package_items_not_itself" CHECK ("service_package_items"."package_variant_id" <> "service_package_items"."service_variant_id")
);
--> statement-breakpoint
CREATE TABLE "service_staff" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"membership_id" uuid,
	"commission_rate" numeric(7, 6) DEFAULT '0' NOT NULL,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_staff_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_staff_name_check" CHECK (length(btrim("service_staff"."display_name")) BETWEEN 1 AND 80),
	CONSTRAINT "service_staff_rate_check" CHECK ("service_staff"."commission_rate" >= 0 AND "service_staff"."commission_rate" <= 1),
	CONSTRAINT "service_staff_color_check" CHECK ("service_staff"."color" IS NULL OR "service_staff"."color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "service_staff_hours" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	CONSTRAINT "service_staff_hours_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_staff_hours_weekday_check" CHECK ("service_staff_hours"."weekday" BETWEEN 0 AND 6),
	CONSTRAINT "service_staff_hours_span_check" CHECK ("service_staff_hours"."ends_at" > "service_staff_hours"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "service_staff_services" (
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"commission_rate" numeric(7, 6),
	CONSTRAINT "service_staff_services_tenant_id_staff_id_variant_id_pk" PRIMARY KEY("tenant_id","staff_id","variant_id"),
	CONSTRAINT "service_staff_services_rate_check" CHECK ("service_staff_services"."commission_rate" IS NULL OR ("service_staff_services"."commission_rate" >= 0 AND "service_staff_services"."commission_rate" <= 1))
);
--> statement-breakpoint
CREATE TABLE "service_staff_time_off" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"staff_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_staff_time_off_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_staff_time_off_span_check" CHECK ("service_staff_time_off"."ends_at" > "service_staff_time_off"."starts_at"),
	CONSTRAINT "service_staff_time_off_reason_check" CHECK ("service_staff_time_off"."reason" IS NULL OR length("service_staff_time_off"."reason") <= 200)
);
--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_business_type_check";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_type_check";--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_service_untracked";--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "service_minutes" integer;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "package_valid_days" integer;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "service_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "commission_rate" numeric(7, 6);--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "customer_package_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "package_value" numeric(20, 4);--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_tenant_id_appointment_id_appointments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","appointment_id") REFERENCES "public"."appointments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_tenant_id_staff_id_service_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."service_staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_package_entries" ADD CONSTRAINT "customer_package_entries_tenant_id_customer_package_id_customer_packages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_package_id") REFERENCES "public"."customer_packages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_package_entries" ADD CONSTRAINT "customer_package_entries_tenant_id_customer_package_item_id_customer_package_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_package_item_id") REFERENCES "public"."customer_package_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_package_entries" ADD CONSTRAINT "customer_package_entries_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_package_entries" ADD CONSTRAINT "customer_package_entries_tenant_id_sale_line_id_sale_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_package_entries" ADD CONSTRAINT "customer_package_entries_tenant_id_sale_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_package_items" ADD CONSTRAINT "customer_package_items_tenant_id_customer_package_id_customer_packages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_package_id") REFERENCES "public"."customer_packages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_package_items" ADD CONSTRAINT "customer_package_items_tenant_id_service_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","service_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_tenant_id_package_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","package_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_packages" ADD CONSTRAINT "customer_packages_tenant_id_sale_line_id_sale_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tip_shares" ADD CONSTRAINT "sale_tip_shares_tenant_id_sale_tip_id_sale_tips_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_tip_id") REFERENCES "public"."sale_tips"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tip_shares" ADD CONSTRAINT "sale_tip_shares_tenant_id_staff_id_service_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."service_staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_package_items" ADD CONSTRAINT "service_package_items_tenant_id_package_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","package_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_package_items" ADD CONSTRAINT "service_package_items_tenant_id_service_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","service_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff" ADD CONSTRAINT "service_staff_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff" ADD CONSTRAINT "service_staff_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff" ADD CONSTRAINT "service_staff_tenant_id_membership_id_tenant_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."tenant_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff_hours" ADD CONSTRAINT "service_staff_hours_tenant_id_staff_id_service_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."service_staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff_services" ADD CONSTRAINT "service_staff_services_tenant_id_staff_id_service_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."service_staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff_services" ADD CONSTRAINT "service_staff_services_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_staff_time_off" ADD CONSTRAINT "service_staff_time_off_tenant_id_staff_id_service_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","staff_id") REFERENCES "public"."service_staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_services_staff_idx" ON "appointment_services" USING btree ("tenant_id","staff_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_sale_once" ON "appointments" USING btree ("tenant_id","sale_id") WHERE "appointments"."sale_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "appointments_branch_time_idx" ON "appointments" USING btree ("tenant_id","branch_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_customer_idx" ON "appointments" USING btree ("tenant_id","customer_id","starts_at") WHERE "appointments"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "appointments_reminder_idx" ON "appointments" USING btree ("starts_at") WHERE "appointments"."status" = 'BOOKED' AND "appointments"."remind" AND "appointments"."reminded_at" IS NULL;--> statement-breakpoint
CREATE INDEX "customer_notes_customer_idx" ON "customer_notes" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_package_entries_item_idx" ON "customer_package_entries" USING btree ("tenant_id","customer_package_item_id");--> statement-breakpoint
CREATE INDEX "customer_package_entries_package_idx" ON "customer_package_entries" USING btree ("tenant_id","customer_package_id");--> statement-breakpoint
CREATE INDEX "customer_packages_customer_idx" ON "customer_packages" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_staff_membership_once" ON "service_staff" USING btree ("tenant_id","membership_id") WHERE "service_staff"."membership_id" IS NOT NULL AND "service_staff"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "service_staff_branch_idx" ON "service_staff" USING btree ("tenant_id","branch_id");--> statement-breakpoint
CREATE INDEX "service_staff_hours_staff_idx" ON "service_staff_hours" USING btree ("tenant_id","staff_id");--> statement-breakpoint
CREATE INDEX "service_staff_time_off_staff_idx" ON "service_staff_time_off" USING btree ("tenant_id","staff_id","starts_at");--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_service_staff_id_service_staff_tenant_id_id_fk" FOREIGN KEY ("tenant_id","service_staff_id") REFERENCES "public"."service_staff"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_customer_package_id_customer_packages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_package_id") REFERENCES "public"."customer_packages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_lines_staff_idx" ON "sale_lines" USING btree ("tenant_id","service_staff_id") WHERE "sale_lines"."service_staff_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sale_lines_package_idx" ON "sale_lines" USING btree ("tenant_id","customer_package_id") WHERE "sale_lines"."customer_package_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_check" CHECK ("tenants"."business_type" IN ('RETAIL','RESTAURANT','HYBRID','GROCERY','SALON'));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_service_minutes_range" CHECK ("product_variants"."service_minutes" IS NULL OR "product_variants"."service_minutes" BETWEEN 5 AND 720);--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_package_days_range" CHECK ("product_variants"."package_valid_days" IS NULL OR "product_variants"."package_valid_days" BETWEEN 1 AND 3650);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_type_check" CHECK ("products"."product_type" IN ('STANDARD','SERVICE','PACKAGE'));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_service_untracked" CHECK ("products"."product_type" = 'STANDARD' OR NOT "products"."track_inventory");--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_staff_rate" CHECK (("sale_lines"."service_staff_id" IS NULL) = ("sale_lines"."commission_rate" IS NULL));--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_package_value" CHECK (("sale_lines"."customer_package_id" IS NULL) = ("sale_lines"."package_value" IS NULL) AND coalesce("sale_lines"."package_value", 0) >= 0);