CREATE TABLE "job_order_deposits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"method" text,
	"cashier_session_id" uuid,
	"payment_intent_id" uuid,
	"reference" text,
	"reason" text,
	"sale_id" uuid,
	"net_amount" numeric(20, 4),
	"vat_amount" numeric(20, 4),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_deposits_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_order_deposits_kind_check" CHECK ("job_order_deposits"."kind" IN ('RECEIVED','APPLIED','REFUNDED','FORFEITED')),
	CONSTRAINT "job_order_deposits_sign_check" CHECK (CASE WHEN "job_order_deposits"."kind" = 'RECEIVED' THEN "job_order_deposits"."amount" > 0 ELSE "job_order_deposits"."amount" < 0 END),
	CONSTRAINT "job_order_deposits_method_check" CHECK (CASE WHEN "job_order_deposits"."kind" IN ('RECEIVED','REFUNDED') THEN "job_order_deposits"."method" IN ('CASH','CARD','QR','EWALLET','BANK_TRANSFER') ELSE "job_order_deposits"."method" IS NULL END
          AND ("job_order_deposits"."method" IS DISTINCT FROM 'CASH' OR "job_order_deposits"."cashier_session_id" IS NOT NULL)
          AND coalesce("job_order_deposits"."method" IN ('CARD','QR','EWALLET'), false) = ("job_order_deposits"."payment_intent_id" IS NOT NULL)
          AND coalesce("job_order_deposits"."method" = 'BANK_TRANSFER', false) = ("job_order_deposits"."reference" IS NOT NULL)),
	CONSTRAINT "job_order_deposits_refund_check" CHECK ("job_order_deposits"."kind" <> 'REFUNDED' OR "job_order_deposits"."method" IN ('CASH','BANK_TRANSFER')),
	CONSTRAINT "job_order_deposits_applied_check" CHECK (("job_order_deposits"."kind" = 'APPLIED') = ("job_order_deposits"."sale_id" IS NOT NULL)),
	CONSTRAINT "job_order_deposits_forfeit_check" CHECK (("job_order_deposits"."kind" = 'FORFEITED') = ("job_order_deposits"."net_amount" IS NOT NULL AND "job_order_deposits"."vat_amount" IS NOT NULL)),
	CONSTRAINT "job_order_deposits_text_check" CHECK (coalesce(length("job_order_deposits"."reference"), 0) <= 64 AND coalesce(length("job_order_deposits"."reason"), 0) <= 200)
);
--> statement-breakpoint
CREATE TABLE "job_order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"garment_type_id" uuid,
	"label" text NOT NULL,
	"count" integer NOT NULL,
	"note" text,
	CONSTRAINT "job_order_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_order_items_check" CHECK (length(btrim("job_order_items"."label")) BETWEEN 1 AND 60 AND "job_order_items"."count" BETWEEN 1 AND 999 AND coalesce(length("job_order_items"."note"), 0) <= 200)
);
--> statement-breakpoint
CREATE TABLE "job_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"tax_category_code" text NOT NULL,
	"vat_treatment" text NOT NULL,
	"laundry_unit" text,
	"measured_quantity" numeric(18, 4) NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(20, 4) NOT NULL,
	"price_includes_tax" boolean NOT NULL,
	"price_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"track_inventory" boolean NOT NULL,
	"product_type" text NOT NULL,
	"promotion_id" uuid,
	"customer_package_id" uuid,
	"gross" numeric(20, 4) NOT NULL,
	"discount" numeric(20, 4) NOT NULL,
	"statutory_discount" numeric(20, 4) NOT NULL,
	"vat_exemption_amount" numeric(20, 4) NOT NULL,
	"vatable_sales" numeric(20, 4) NOT NULL,
	"vat_amount" numeric(20, 4) NOT NULL,
	"vat_exempt_sales" numeric(20, 4) NOT NULL,
	"zero_rated_sales" numeric(20, 4) NOT NULL,
	"percentage_tax_sales" numeric(20, 4) NOT NULL,
	"amount_due" numeric(20, 4) NOT NULL,
	"tax_snapshot" jsonb NOT NULL,
	CONSTRAINT "job_order_lines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_order_lines_number_unique" UNIQUE("tenant_id","job_order_id","line_no"),
	CONSTRAINT "job_order_lines_quantity_check" CHECK ("job_order_lines"."quantity" > 0 AND "job_order_lines"."measured_quantity" > 0 AND "job_order_lines"."quantity" >= "job_order_lines"."measured_quantity"),
	CONSTRAINT "job_order_lines_unit_check" CHECK ("job_order_lines"."laundry_unit" IS NULL OR "job_order_lines"."laundry_unit" IN ('KG','LOAD','PIECE'))
);
--> statement-breakpoint
CREATE TABLE "job_order_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"email_status" text,
	"email_to" text,
	"sms_status" text,
	"sms_to" text,
	"provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "job_order_notices_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_order_notices_once" UNIQUE("tenant_id","job_order_id","kind","step"),
	CONSTRAINT "job_order_notices_kind_check" CHECK ("job_order_notices"."kind" IN ('READY','REMINDER','FINAL')),
	CONSTRAINT "job_order_notices_status_check" CHECK ("job_order_notices"."status" IN ('QUEUED','SENT','FAILED','SKIPPED') AND ("job_order_notices"."status" = 'QUEUED') = ("job_order_notices"."settled_at" IS NULL)),
	CONSTRAINT "job_order_notices_channel_check" CHECK (coalesce("job_order_notices"."email_status", 'SKIPPED') IN ('SENT','FAILED','SKIPPED') AND coalesce("job_order_notices"."sms_status", 'SKIPPED') IN ('SENT','FAILED','SKIPPED')
      AND coalesce(length("job_order_notices"."email_to"), 0) <= 254 AND coalesce(length("job_order_notices"."sms_to"), 0) <= 20 AND coalesce(length("job_order_notices"."provider_reference"), 0) <= 128)
);
--> statement-breakpoint
CREATE TABLE "job_order_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_status_changes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_order_status_changes_note_check" CHECK (coalesce(length("job_order_status_changes"."note"), 0) <= 200)
);
--> statement-breakpoint
CREATE TABLE "job_order_trips" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_order_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"address" text,
	"contact_phone" text,
	"contact_name" text,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"rider_member_id" uuid,
	"rider_name" text,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"fail_reason" text,
	"notes" text,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_order_trips_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_order_trips_kind_check" CHECK ("job_order_trips"."kind" IN ('PICKUP','DELIVERY')),
	CONSTRAINT "job_order_trips_status_check" CHECK ("job_order_trips"."status" IN ('SCHEDULED','DONE','FAILED','CANCELLED')),
	CONSTRAINT "job_order_trips_text_check" CHECK (coalesce(length(btrim("job_order_trips"."address")) BETWEEN 1 AND 300, true) AND coalesce(length(btrim("job_order_trips"."contact_phone")) BETWEEN 7 AND 20, true)
      AND coalesce(length("job_order_trips"."contact_name"), 0) <= 120 AND coalesce(length("job_order_trips"."rider_name"), 0) <= 80 AND coalesce(length("job_order_trips"."notes"), 0) <= 300 AND coalesce(length("job_order_trips"."fail_reason"), 0) <= 200),
	CONSTRAINT "job_order_trips_window_check" CHECK ("job_order_trips"."window_start" IS NULL OR "job_order_trips"."window_end" IS NULL OR "job_order_trips"."window_end" > "job_order_trips"."window_start"),
	CONSTRAINT "job_order_trips_done_check" CHECK (("job_order_trips"."status" = 'DONE') = ("job_order_trips"."done_at" IS NOT NULL) AND ("job_order_trips"."status" IN ('FAILED','CANCELLED')) = ("job_order_trips"."fail_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "job_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"claim_code" text NOT NULL,
	"customer_id" uuid,
	"customer_name" text,
	"customer_phone" text,
	"service_level" text DEFAULT 'REGULAR' NOT NULL,
	"promised_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"weight_kg" numeric(12, 3),
	"bag_count" smallint DEFAULT 1 NOT NULL,
	"special_instructions" text,
	"condition_notes" text,
	"pickup_requested" boolean DEFAULT false NOT NULL,
	"delivery_requested" boolean DEFAULT false NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"tax_profile_id" uuid,
	"tax_snapshot" jsonb,
	"requires_professional_review" boolean DEFAULT false NOT NULL,
	"priced_at" timestamp with time zone,
	"amount_due" numeric(20, 4) DEFAULT '0' NOT NULL,
	"sale_id" uuid,
	"ready_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"disposed_at" timestamp with time zone,
	"disposed_reason" text,
	"disposed_note" text,
	"received_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_orders_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "job_orders_tenant_branch_id_unique" UNIQUE("tenant_id","branch_id","id"),
	CONSTRAINT "job_orders_number_unique" UNIQUE("tenant_id","branch_id","number"),
	CONSTRAINT "job_orders_claim_code_unique" UNIQUE("tenant_id","claim_code"),
	CONSTRAINT "job_orders_status_check" CHECK ("job_orders"."status" IN ('RECEIVED','WASHING','DRYING','FOLDING','READY','OUT_FOR_DELIVERY','CLAIMED','CANCELLED','DISPOSED')),
	CONSTRAINT "job_orders_level_check" CHECK ("job_orders"."service_level" IN ('REGULAR','EXPRESS')),
	CONSTRAINT "job_orders_number_check" CHECK ("job_orders"."number" > 0 AND "job_orders"."claim_code" ~ '^[A-Z0-9]{6}$'),
	CONSTRAINT "job_orders_who_check" CHECK ("job_orders"."customer_id" IS NOT NULL OR length(btrim(coalesce("job_orders"."customer_name", ''))) BETWEEN 1 AND 120),
	CONSTRAINT "job_orders_text_check" CHECK (coalesce(length("job_orders"."customer_name"), 0) <= 120 AND coalesce(length("job_orders"."customer_phone"), 0) <= 20
      AND coalesce(length("job_orders"."special_instructions"), 0) <= 500 AND coalesce(length("job_orders"."condition_notes"), 0) <= 500
      AND coalesce(length("job_orders"."cancel_reason"), 0) <= 200 AND coalesce(length("job_orders"."disposed_note"), 0) <= 200),
	CONSTRAINT "job_orders_weight_check" CHECK (("job_orders"."weight_kg" IS NULL OR "job_orders"."weight_kg" > 0) AND "job_orders"."bag_count" BETWEEN 1 AND 99 AND "job_orders"."amount_due" >= 0),
	CONSTRAINT "job_orders_priced_check" CHECK (("job_orders"."priced_at" IS NULL) = ("job_orders"."tax_profile_id" IS NULL) AND ("job_orders"."priced_at" IS NULL) = ("job_orders"."tax_snapshot" IS NULL)),
	CONSTRAINT "job_orders_claimed_check" CHECK (("job_orders"."status" = 'CLAIMED') = ("job_orders"."sale_id" IS NOT NULL AND "job_orders"."claimed_at" IS NOT NULL)),
	CONSTRAINT "job_orders_cancelled_check" CHECK (("job_orders"."status" = 'CANCELLED') = ("job_orders"."cancelled_at" IS NOT NULL AND length(btrim(coalesce("job_orders"."cancel_reason", ''))) > 0)),
	CONSTRAINT "job_orders_disposed_check" CHECK (("job_orders"."status" = 'DISPOSED') = ("job_orders"."disposed_at" IS NOT NULL AND "job_orders"."disposed_reason" IN ('DONATED','DISCARDED','OTHER')))
);
--> statement-breakpoint
CREATE TABLE "laundry_garment_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "laundry_garment_types_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "laundry_garment_types_name_check" CHECK (length(btrim("laundry_garment_types"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE TABLE "laundry_machines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"capacity_kg" numeric(12, 3),
	"cycle_minutes" integer NOT NULL,
	"out_of_order_reason" text,
	"is_sample" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "laundry_machines_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "laundry_machines_tenant_branch_id_unique" UNIQUE("tenant_id","branch_id","id"),
	CONSTRAINT "laundry_machines_kind_check" CHECK ("laundry_machines"."kind" IN ('WASHER','DRYER')),
	CONSTRAINT "laundry_machines_label_check" CHECK (length(btrim("laundry_machines"."label")) BETWEEN 1 AND 30),
	CONSTRAINT "laundry_machines_minutes_check" CHECK ("laundry_machines"."cycle_minutes" BETWEEN 1 AND 240 AND ("laundry_machines"."capacity_kg" IS NULL OR "laundry_machines"."capacity_kg" > 0)),
	CONSTRAINT "laundry_machines_reason_check" CHECK ("laundry_machines"."out_of_order_reason" IS NULL OR length(btrim("laundry_machines"."out_of_order_reason")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "laundry_settings" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"regular_hours" integer DEFAULT 48 NOT NULL,
	"express_hours" integer DEFAULT 6 NOT NULL,
	"express_variant_id" uuid,
	"delivery_variant_id" uuid,
	"storage_fee_variant_id" uuid,
	"storage_free_days" integer,
	"unclaimed_days" integer DEFAULT 30 NOT NULL,
	"final_notice_days" integer DEFAULT 3 NOT NULL,
	"reminder_days" integer[] DEFAULT '{3,7}'::integer[] NOT NULL,
	"claim_policy_text" text,
	"sms_enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "laundry_settings_tenant_id_branch_id_pk" PRIMARY KEY("tenant_id","branch_id"),
	CONSTRAINT "laundry_settings_hours_check" CHECK ("laundry_settings"."regular_hours" BETWEEN 1 AND 720 AND "laundry_settings"."express_hours" BETWEEN 1 AND 168),
	CONSTRAINT "laundry_settings_days_check" CHECK ("laundry_settings"."unclaimed_days" BETWEEN 7 AND 365 AND "laundry_settings"."final_notice_days" BETWEEN 1 AND 30 AND "laundry_settings"."final_notice_days" < "laundry_settings"."unclaimed_days"
      AND ("laundry_settings"."storage_free_days" IS NULL OR "laundry_settings"."storage_free_days" BETWEEN 0 AND 365) AND cardinality("laundry_settings"."reminder_days") <= 5),
	CONSTRAINT "laundry_settings_policy_check" CHECK ("laundry_settings"."claim_policy_text" IS NULL OR length("laundry_settings"."claim_policy_text") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "machine_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"source" text NOT NULL,
	"sale_id" uuid,
	"sale_line_id" uuid,
	"job_order_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"planned_minutes" integer NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"stopped_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_runs_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "machine_runs_source_check" CHECK (("machine_runs"."source" = 'SELF_SERVICE' AND "machine_runs"."sale_line_id" IS NOT NULL AND "machine_runs"."sale_id" IS NOT NULL AND "machine_runs"."job_order_id" IS NULL)
      OR ("machine_runs"."source" = 'JOB' AND "machine_runs"."job_order_id" IS NOT NULL AND "machine_runs"."sale_line_id" IS NULL AND "machine_runs"."sale_id" IS NULL)),
	CONSTRAINT "machine_runs_time_check" CHECK ("machine_runs"."planned_minutes" BETWEEN 1 AND 240 AND "machine_runs"."ends_at" > "machine_runs"."started_at"
      AND ("machine_runs"."stopped_at" IS NULL OR ("machine_runs"."stopped_at" >= "machine_runs"."started_at" AND "machine_runs"."stopped_at" < "machine_runs"."ends_at")))
);
--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_business_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_consumer_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_intent_check";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "laundry_unit" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "laundry_min_quantity" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "laundry_kg_per_load" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "laundry_addon" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "machine_kind" text;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "machine_minutes" integer;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "job_order_deposit_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "job_order_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD COLUMN "machine_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD COLUMN "job_order_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "job_order_id" uuid;--> statement-breakpoint
ALTER TABLE "job_order_deposits" ADD CONSTRAINT "job_order_deposits_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_deposits" ADD CONSTRAINT "job_order_deposits_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_deposits" ADD CONSTRAINT "job_order_deposits_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_deposits" ADD CONSTRAINT "job_order_deposits_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_deposits" ADD CONSTRAINT "job_order_deposits_tenant_id_payment_intent_id_payment_intents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_deposits" ADD CONSTRAINT "job_order_deposits_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_items" ADD CONSTRAINT "job_order_items_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_items" ADD CONSTRAINT "job_order_items_tenant_id_garment_type_id_laundry_garment_types_tenant_id_id_fk" FOREIGN KEY ("tenant_id","garment_type_id") REFERENCES "public"."laundry_garment_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_lines" ADD CONSTRAINT "job_order_lines_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_lines" ADD CONSTRAINT "job_order_lines_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_lines" ADD CONSTRAINT "job_order_lines_tenant_id_price_id_product_prices_tenant_id_id_fk" FOREIGN KEY ("tenant_id","price_id") REFERENCES "public"."product_prices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_lines" ADD CONSTRAINT "job_order_lines_tenant_id_promotion_id_promotions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","promotion_id") REFERENCES "public"."promotions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_lines" ADD CONSTRAINT "job_order_lines_tenant_id_customer_package_id_customer_packages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_package_id") REFERENCES "public"."customer_packages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_notices" ADD CONSTRAINT "job_order_notices_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_status_changes" ADD CONSTRAINT "job_order_status_changes_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_trips" ADD CONSTRAINT "job_order_trips_tenant_id_branch_id_job_order_id_job_orders_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_order_trips" ADD CONSTRAINT "job_order_trips_tenant_id_rider_member_id_tenant_memberships_tenant_id_id_fk" FOREIGN KEY ("tenant_id","rider_member_id") REFERENCES "public"."tenant_memberships"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_tenant_id_tax_profile_id_tax_profiles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","tax_profile_id") REFERENCES "public"."tax_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_orders" ADD CONSTRAINT "job_orders_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laundry_garment_types" ADD CONSTRAINT "laundry_garment_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laundry_machines" ADD CONSTRAINT "laundry_machines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laundry_machines" ADD CONSTRAINT "laundry_machines_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laundry_settings" ADD CONSTRAINT "laundry_settings_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laundry_settings" ADD CONSTRAINT "laundry_settings_tenant_id_express_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","express_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laundry_settings" ADD CONSTRAINT "laundry_settings_tenant_id_delivery_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","delivery_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laundry_settings" ADD CONSTRAINT "laundry_settings_tenant_id_storage_fee_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","storage_fee_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_runs" ADD CONSTRAINT "machine_runs_tenant_id_branch_id_machine_id_laundry_machines_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","machine_id") REFERENCES "public"."laundry_machines"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_runs" ADD CONSTRAINT "machine_runs_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_runs" ADD CONSTRAINT "machine_runs_tenant_id_sale_line_id_sale_lines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_line_id") REFERENCES "public"."sale_lines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_runs" ADD CONSTRAINT "machine_runs_tenant_id_branch_id_job_order_id_job_orders_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_order_deposits_intent_once" ON "job_order_deposits" USING btree ("tenant_id","payment_intent_id") WHERE "job_order_deposits"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_order_deposits_applied_once" ON "job_order_deposits" USING btree ("tenant_id","sale_id") WHERE "job_order_deposits"."kind" = 'APPLIED';--> statement-breakpoint
CREATE INDEX "job_order_deposits_job_idx" ON "job_order_deposits" USING btree ("tenant_id","job_order_id");--> statement-breakpoint
CREATE INDEX "job_order_deposits_session_idx" ON "job_order_deposits" USING btree ("tenant_id","cashier_session_id") WHERE "job_order_deposits"."cashier_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_order_items_job_idx" ON "job_order_items" USING btree ("tenant_id","job_order_id");--> statement-breakpoint
CREATE INDEX "job_order_lines_job_idx" ON "job_order_lines" USING btree ("tenant_id","job_order_id");--> statement-breakpoint
CREATE INDEX "job_order_status_changes_job_idx" ON "job_order_status_changes" USING btree ("tenant_id","job_order_id","changed_at");--> statement-breakpoint
CREATE INDEX "job_order_trips_branch_idx" ON "job_order_trips" USING btree ("tenant_id","branch_id","window_start");--> statement-breakpoint
CREATE INDEX "job_order_trips_job_idx" ON "job_order_trips" USING btree ("tenant_id","job_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_order_trips_live_once" ON "job_order_trips" USING btree ("tenant_id","job_order_id","kind") WHERE "job_order_trips"."status" = 'SCHEDULED';--> statement-breakpoint
CREATE UNIQUE INDEX "job_orders_sale_once" ON "job_orders" USING btree ("tenant_id","sale_id") WHERE "job_orders"."sale_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_orders_branch_status_idx" ON "job_orders" USING btree ("tenant_id","branch_id","status");--> statement-breakpoint
CREATE INDEX "job_orders_customer_idx" ON "job_orders" USING btree ("tenant_id","customer_id") WHERE "job_orders"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "job_orders_ready_idx" ON "job_orders" USING btree ("tenant_id","ready_at") WHERE "job_orders"."status" = 'READY';--> statement-breakpoint
CREATE UNIQUE INDEX "laundry_garment_types_name_active_unique" ON "laundry_garment_types" USING btree ("tenant_id",lower("name")) WHERE "laundry_garment_types"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "laundry_machines_label_active_unique" ON "laundry_machines" USING btree ("tenant_id","branch_id",lower("label")) WHERE "laundry_machines"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_runs_sale_line_once" ON "machine_runs" USING btree ("tenant_id","sale_line_id") WHERE "machine_runs"."sale_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "machine_runs_machine_idx" ON "machine_runs" USING btree ("tenant_id","machine_id","started_at");--> statement-breakpoint
CREATE INDEX "machine_runs_branch_idx" ON "machine_runs" USING btree ("tenant_id","branch_id","started_at");--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_job_order_deposit_id_job_order_deposits_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_deposit_id") REFERENCES "public"."job_order_deposits"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_tenant_id_machine_id_laundry_machines_tenant_id_id_fk" FOREIGN KEY ("tenant_id","machine_id") REFERENCES "public"."laundry_machines"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_job_order_id_job_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_order_id") REFERENCES "public"."job_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_job_order_once" ON "sales" USING btree ("tenant_id","job_order_id") WHERE "sales"."job_order_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_check" CHECK ("tenants"."business_type" IN ('RETAIL','RESTAURANT','HYBRID','GROCERY','SALON','LODGING','LAUNDRY'));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_laundry_check" CHECK (("product_variants"."laundry_unit" IS NULL OR "product_variants"."laundry_unit" IN ('KG','LOAD','PIECE')) AND coalesce("product_variants"."laundry_min_quantity", 1) > 0
          AND ("product_variants"."laundry_kg_per_load" IS NULL OR ("product_variants"."laundry_unit" = 'LOAD' AND "product_variants"."laundry_kg_per_load" > 0))
          AND ("product_variants"."laundry_min_quantity" IS NULL OR "product_variants"."laundry_unit" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_machine_check" CHECK (("product_variants"."machine_kind" IS NULL) = ("product_variants"."machine_minutes" IS NULL) AND ("product_variants"."machine_kind" IS NULL OR "product_variants"."machine_kind" IN ('WASHER','DRYER'))
          AND ("product_variants"."machine_minutes" IS NULL OR "product_variants"."machine_minutes" BETWEEN 1 AND 240));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_job_deposit_link" CHECK (("cash_movements"."type" IN ('JOB_DEPOSIT','JOB_DEPOSIT_REFUND')) = ("cash_movements"."job_order_deposit_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND','TIP','TIP_REFUND','TIP_PAYOUT','FOLIO_PAYMENT','DEPOSIT','DEPOSIT_REFUND','JOB_DEPOSIT','JOB_DEPOSIT_REFUND'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND','TIP_REFUND','TIP_PAYOUT','DEPOSIT_REFUND','JOB_DEPOSIT_REFUND') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" IN ('PAY_IN','TIP','FOLIO_PAYMENT','DEPOSIT','JOB_DEPOSIT') AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" IN ('SALE','TIP','FOLIO','JOB_ORDER'));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_consumer_check" CHECK (("payment_intents"."sale_id" IS NULL OR "payment_intents"."purpose" IN ('SALE','TIP')) AND ("payment_intents"."folio_id" IS NULL OR ("payment_intents"."purpose" = 'FOLIO' AND "payment_intents"."status" = 'SUCCEEDED'))
          AND ("payment_intents"."job_order_id" IS NULL OR ("payment_intents"."purpose" = 'JOB_ORDER' AND "payment_intents"."status" = 'SUCCEEDED')));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_job_deposit_check" CHECK (("sale_tenders"."method" = 'JOB_DEPOSIT') = ("sale_tenders"."job_order_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_method_check" CHECK ("sale_tenders"."method" IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT','ROOM_CHARGE','JOB_DEPOSIT'));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_intent_check" CHECK (("sale_tenders"."method" IN ('CASH','STORE_CREDIT','ROOM_CHARGE','JOB_DEPOSIT')) = ("sale_tenders"."payment_intent_id" IS NULL));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','SUPPLIER_NOTE','PACK_OPENING','SALE_TIP_REFUND','FOLIO_ENTRY','FOLIO_PAYMENT','STAY_DEPOSIT','JOB_ORDER_DEPOSIT','MANUAL','REVERSAL'));