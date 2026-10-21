CREATE TABLE "folio_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"folio_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"night_date" date,
	"description" text,
	"reason" text,
	"gross" numeric(20, 4),
	"discount" numeric(20, 4),
	"statutory_discount" numeric(20, 4),
	"vat_exemption_amount" numeric(20, 4),
	"vatable_sales" numeric(20, 4),
	"vat_amount" numeric(20, 4),
	"vat_exempt_sales" numeric(20, 4),
	"zero_rated_sales" numeric(20, 4),
	"percentage_tax_sales" numeric(20, 4),
	"unit_price" numeric(20, 4),
	"variant_id" uuid,
	"tax_category_code" text,
	"vat_treatment" text,
	"tax_profile_id" uuid,
	"tax_snapshot" jsonb,
	"sale_id" uuid,
	"sale_return_id" uuid,
	"folio_payment_id" uuid,
	"stay_deposit_id" uuid,
	"related_entry_id" uuid,
	"journal_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folio_entries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "folio_entries_kind_check" CHECK ("folio_entries"."kind" IN ('ROOM_NIGHT','ACCOMMODATION_TAX','CHARGE','CHARGE_RETURN','DEPOSIT_APPLIED','PAYMENT','ADJUSTMENT','NIGHT_REVERSAL')),
	CONSTRAINT "folio_entries_sign_check" CHECK (CASE WHEN "folio_entries"."kind" IN ('ROOM_NIGHT','CHARGE') THEN "folio_entries"."amount" >= 0
               WHEN "folio_entries"."kind" = 'ACCOMMODATION_TAX' THEN "folio_entries"."amount" > 0
               WHEN "folio_entries"."kind" IN ('CHARGE_RETURN','DEPOSIT_APPLIED','PAYMENT','NIGHT_REVERSAL') THEN "folio_entries"."amount" < 0
               ELSE "folio_entries"."amount" <> 0 END),
	CONSTRAINT "folio_entries_link_check" CHECK (CASE "folio_entries"."kind"
            WHEN 'ROOM_NIGHT' THEN "folio_entries"."night_date" IS NOT NULL AND "folio_entries"."variant_id" IS NOT NULL AND "folio_entries"."tax_profile_id" IS NOT NULL AND "folio_entries"."related_entry_id" IS NULL
            WHEN 'ACCOMMODATION_TAX' THEN "folio_entries"."night_date" IS NOT NULL AND "folio_entries"."related_entry_id" IS NOT NULL
            WHEN 'CHARGE' THEN "folio_entries"."sale_id" IS NOT NULL AND "folio_entries"."sale_return_id" IS NULL
            WHEN 'CHARGE_RETURN' THEN "folio_entries"."sale_return_id" IS NOT NULL AND "folio_entries"."sale_id" IS NOT NULL
            WHEN 'DEPOSIT_APPLIED' THEN "folio_entries"."stay_deposit_id" IS NOT NULL
            WHEN 'PAYMENT' THEN "folio_entries"."folio_payment_id" IS NOT NULL
            WHEN 'ADJUSTMENT' THEN "folio_entries"."reason" IS NOT NULL AND "folio_entries"."tax_profile_id" IS NOT NULL
            WHEN 'NIGHT_REVERSAL' THEN "folio_entries"."related_entry_id" IS NOT NULL AND "folio_entries"."reason" IS NOT NULL END),
	CONSTRAINT "folio_entries_text_check" CHECK (coalesce(length("folio_entries"."reason"), 0) <= 200 AND coalesce(length("folio_entries"."description"), 0) <= 120)
);
--> statement-breakpoint
CREATE TABLE "folio_payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"folio_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"register_id" uuid NOT NULL,
	"cashier_session_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"tendered" numeric(20, 4) NOT NULL,
	"change" numeric(20, 4) DEFAULT '0' NOT NULL,
	"payment_intent_id" uuid,
	"reference" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folio_payments_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "folio_payments_method_check" CHECK ("folio_payments"."method" IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT','BANK_TRANSFER')),
	CONSTRAINT "folio_payments_intent_check" CHECK (("folio_payments"."method" IN ('CARD','QR','EWALLET')) = ("folio_payments"."payment_intent_id" IS NOT NULL)),
	CONSTRAINT "folio_payments_reference_check" CHECK (("folio_payments"."method" = 'BANK_TRANSFER') = ("folio_payments"."reference" IS NOT NULL) AND coalesce(length("folio_payments"."reference"), 0) <= 64),
	CONSTRAINT "folio_payments_amounts_check" CHECK ("folio_payments"."amount" > 0 AND "folio_payments"."change" >= 0 AND "folio_payments"."tendered" - "folio_payments"."change" = "folio_payments"."amount" AND ("folio_payments"."method" = 'CASH' OR "folio_payments"."change" = 0))
);
--> statement-breakpoint
CREATE TABLE "folios" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"currency" char(3) DEFAULT 'PHP' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_by" uuid,
	"settled_at" timestamp with time zone,
	CONSTRAINT "folios_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "folios_stay_unique" UNIQUE("tenant_id","stay_id"),
	CONSTRAINT "folios_status_check" CHECK ("folios"."status" IN ('OPEN','SETTLED')),
	CONSTRAINT "folios_settled_check" CHECK (("folios"."status" = 'SETTLED') = ("folios"."settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lodging_settings" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"night_audit_time" time DEFAULT '03:00' NOT NULL,
	"accommodation_tax_rate" numeric(7, 6),
	"forfeit_on_cancel" boolean DEFAULT true NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lodging_settings_tenant_id_branch_id_pk" PRIMARY KEY("tenant_id","branch_id"),
	CONSTRAINT "lodging_settings_tax_rate_check" CHECK ("lodging_settings"."accommodation_tax_rate" IS NULL OR ("lodging_settings"."accommodation_tax_rate" >= 0 AND "lodging_settings"."accommodation_tax_rate" <= 0.2))
);
--> statement-breakpoint
CREATE TABLE "room_blocks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_blocks_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "room_blocks_span_check" CHECK ("room_blocks"."ends_on" > "room_blocks"."starts_on"),
	CONSTRAINT "room_blocks_reason_check" CHECK (length(btrim("room_blocks"."reason")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "room_status_changes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"note" text,
	"stay_id" uuid,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_status_changes_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "room_status_changes_status_check" CHECK ("room_status_changes"."from_status" IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER') AND "room_status_changes"."to_status" IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER')),
	CONSTRAINT "room_status_changes_note_check" CHECK ("room_status_changes"."note" IS NULL OR length("room_status_changes"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "room_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"base_occupancy" smallint DEFAULT 2 NOT NULL,
	"max_occupancy" smallint DEFAULT 2 NOT NULL,
	"night_variant_id" uuid NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_types_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "room_types_code_check" CHECK ("room_types"."code" ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
	CONSTRAINT "room_types_name_check" CHECK (length(btrim("room_types"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "room_types_occupancy_check" CHECK ("room_types"."base_occupancy" BETWEEN 1 AND 20 AND "room_types"."max_occupancy" BETWEEN "room_types"."base_occupancy" AND 20)
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"number" text NOT NULL,
	"floor" text,
	"notes" text,
	"housekeeping_status" text DEFAULT 'CLEAN' NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "rooms_tenant_branch_id_unique" UNIQUE("tenant_id","branch_id","id"),
	CONSTRAINT "rooms_number_check" CHECK (length(btrim("rooms"."number")) BETWEEN 1 AND 20),
	CONSTRAINT "rooms_floor_check" CHECK ("rooms"."floor" IS NULL OR length("rooms"."floor") <= 20),
	CONSTRAINT "rooms_notes_check" CHECK ("rooms"."notes" IS NULL OR length("rooms"."notes") <= 500),
	CONSTRAINT "rooms_status_check" CHECK ("rooms"."housekeeping_status" IN ('CLEAN','DIRTY','INSPECTED','OUT_OF_ORDER'))
);
--> statement-breakpoint
CREATE TABLE "stay_beneficiaries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"scheme_code" text NOT NULL,
	"name" text NOT NULL,
	"id_number" text NOT NULL,
	"share" numeric(7, 6),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "stay_beneficiaries_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stay_beneficiaries_share_check" CHECK ("stay_beneficiaries"."share" IS NULL OR ("stay_beneficiaries"."share" > 0 AND "stay_beneficiaries"."share" <= 1)),
	CONSTRAINT "stay_beneficiaries_name_check" CHECK (length(btrim("stay_beneficiaries"."name")) BETWEEN 1 AND 200 AND length(btrim("stay_beneficiaries"."id_number")) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "stay_deposits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"folio_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"method" text,
	"cashier_session_id" uuid,
	"payment_intent_id" uuid,
	"reference" text,
	"reason" text,
	"net_amount" numeric(20, 4),
	"vat_amount" numeric(20, 4),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stay_deposits_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stay_deposits_kind_check" CHECK ("stay_deposits"."kind" IN ('RECEIVED','APPLIED','REFUNDED','FORFEITED')),
	CONSTRAINT "stay_deposits_sign_check" CHECK (CASE WHEN "stay_deposits"."kind" = 'RECEIVED' THEN "stay_deposits"."amount" > 0 ELSE "stay_deposits"."amount" < 0 END),
	CONSTRAINT "stay_deposits_method_check" CHECK (CASE WHEN "stay_deposits"."kind" IN ('RECEIVED','REFUNDED') THEN "stay_deposits"."method" IN ('CASH','CARD','QR','EWALLET','BANK_TRANSFER') ELSE "stay_deposits"."method" IS NULL END
          AND ("stay_deposits"."method" IS DISTINCT FROM 'CASH' OR "stay_deposits"."cashier_session_id" IS NOT NULL)
          AND coalesce("stay_deposits"."method" IN ('CARD','QR','EWALLET'), false) = ("stay_deposits"."payment_intent_id" IS NOT NULL)
          AND coalesce("stay_deposits"."method" = 'BANK_TRANSFER', false) = ("stay_deposits"."reference" IS NOT NULL)),
	CONSTRAINT "stay_deposits_refund_check" CHECK ("stay_deposits"."kind" <> 'REFUNDED' OR "stay_deposits"."method" IN ('CASH','BANK_TRANSFER')),
	CONSTRAINT "stay_deposits_forfeit_check" CHECK (("stay_deposits"."kind" = 'FORFEITED') = ("stay_deposits"."net_amount" IS NOT NULL AND "stay_deposits"."vat_amount" IS NOT NULL)),
	CONSTRAINT "stay_deposits_text_check" CHECK (coalesce(length("stay_deposits"."reference"), 0) <= 64 AND coalesce(length("stay_deposits"."reason"), 0) <= 200)
);
--> statement-breakpoint
CREATE TABLE "stay_guests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stay_id" uuid NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"full_name" text NOT NULL,
	"nationality" text,
	"id_type" text,
	"id_number" text,
	"address" text,
	"birth_date" date,
	"contact" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stay_guests_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stay_guests_name_check" CHECK (length(btrim("stay_guests"."full_name")) BETWEEN 1 AND 120),
	CONSTRAINT "stay_guests_lengths_check" CHECK (coalesce(length("stay_guests"."nationality"), 0) <= 60 AND coalesce(length("stay_guests"."id_type"), 0) <= 40 AND coalesce(length("stay_guests"."id_number"), 0) <= 64
      AND coalesce(length("stay_guests"."address"), 0) <= 300 AND coalesce(length("stay_guests"."contact"), 0) <= 120)
);
--> statement-breakpoint
CREATE TABLE "stays" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"room_type_id" uuid NOT NULL,
	"customer_id" uuid,
	"guest_name" text,
	"arrival_date" date NOT NULL,
	"departure_date" date NOT NULL,
	"adults" smallint DEFAULT 1 NOT NULL,
	"children" smallint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'BOOKED' NOT NULL,
	"nightly_rate" numeric(20, 4),
	"allow_charges" boolean DEFAULT true NOT NULL,
	"charge_limit" numeric(20, 4),
	"source" text DEFAULT 'WALK_IN' NOT NULL,
	"external_reference" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" uuid,
	"checked_out_at" timestamp with time zone,
	"checked_out_by" uuid,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	CONSTRAINT "stays_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "stays_status_check" CHECK ("stays"."status" IN ('BOOKED','IN_HOUSE','CHECKED_OUT','CANCELLED','NO_SHOW')),
	CONSTRAINT "stays_dates_check" CHECK ("stays"."departure_date" > "stays"."arrival_date"),
	CONSTRAINT "stays_guests_check" CHECK ("stays"."adults" BETWEEN 1 AND 20 AND "stays"."children" BETWEEN 0 AND 20),
	CONSTRAINT "stays_who_check" CHECK ("stays"."customer_id" IS NOT NULL OR length(btrim(coalesce("stays"."guest_name", ''))) BETWEEN 1 AND 120),
	CONSTRAINT "stays_guest_name_check" CHECK ("stays"."guest_name" IS NULL OR length("stays"."guest_name") <= 120),
	CONSTRAINT "stays_rate_check" CHECK ("stays"."nightly_rate" IS NULL OR "stays"."nightly_rate" >= 0),
	CONSTRAINT "stays_limit_check" CHECK ("stays"."charge_limit" IS NULL OR "stays"."charge_limit" >= 0),
	CONSTRAINT "stays_source_check" CHECK ("stays"."source" IN ('WALK_IN','PHONE','ONLINE','OTA','OTHER')),
	CONSTRAINT "stays_reference_check" CHECK ("stays"."external_reference" IS NULL OR length("stays"."external_reference") <= 64),
	CONSTRAINT "stays_notes_check" CHECK ("stays"."notes" IS NULL OR length("stays"."notes") <= 500),
	CONSTRAINT "stays_in_house_check" CHECK ("stays"."status" NOT IN ('IN_HOUSE','CHECKED_OUT') OR ("stays"."checked_in_at" IS NOT NULL AND "stays"."checked_in_by" IS NOT NULL)),
	CONSTRAINT "stays_checked_out_check" CHECK (("stays"."status" = 'CHECKED_OUT') = ("stays"."checked_out_at" IS NOT NULL)),
	CONSTRAINT "stays_cancel_check" CHECK (("stays"."status" IN ('CANCELLED','NO_SHOW')) = ("stays"."cancelled_at" IS NOT NULL AND length(btrim(coalesce("stays"."cancel_reason", ''))) BETWEEN 1 AND 200))
);
--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_business_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_type_check";--> statement-breakpoint
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_sign_check";--> statement-breakpoint
ALTER TABLE "customer_credit_entries" DROP CONSTRAINT "customer_credit_entries_kind_check";--> statement-breakpoint
ALTER TABLE "customer_credit_entries" DROP CONSTRAINT "customer_credit_entries_link_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_purpose_check";--> statement-breakpoint
ALTER TABLE "sale_returns" DROP CONSTRAINT "sale_returns_refund_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_method_check";--> statement-breakpoint
ALTER TABLE "sale_tenders" DROP CONSTRAINT "sale_tenders_intent_check";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP CONSTRAINT "journal_entries_source_check";--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "folio_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD COLUMN "stay_deposit_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD COLUMN "folio_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "folio_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD COLUMN "stay_id" uuid;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_folio_id_folios_tenant_id_id_fk" FOREIGN KEY ("tenant_id","folio_id") REFERENCES "public"."folios"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_stay_id_stays_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_id") REFERENCES "public"."stays"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_tax_profile_id_tax_profiles_tenant_id_id_fk" FOREIGN KEY ("tenant_id","tax_profile_id") REFERENCES "public"."tax_profiles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_sale_return_id_sale_returns_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_return_id") REFERENCES "public"."sale_returns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_folio_payment_id_folio_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","folio_payment_id") REFERENCES "public"."folio_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_stay_deposit_id_stay_deposits_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_deposit_id") REFERENCES "public"."stay_deposits"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_entries" ADD CONSTRAINT "folio_entries_tenant_id_related_entry_id_folio_entries_tenant_id_id_fk" FOREIGN KEY ("tenant_id","related_entry_id") REFERENCES "public"."folio_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_tenant_id_folio_id_folios_tenant_id_id_fk" FOREIGN KEY ("tenant_id","folio_id") REFERENCES "public"."folios"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_tenant_id_branch_id_register_id_registers_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","register_id") REFERENCES "public"."registers"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_payments" ADD CONSTRAINT "folio_payments_tenant_id_payment_intent_id_payment_intents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folios" ADD CONSTRAINT "folios_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folios" ADD CONSTRAINT "folios_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folios" ADD CONSTRAINT "folios_tenant_id_stay_id_stays_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_id") REFERENCES "public"."stays"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lodging_settings" ADD CONSTRAINT "lodging_settings_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_tenant_id_branch_id_room_id_rooms_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","room_id") REFERENCES "public"."rooms"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_status_changes" ADD CONSTRAINT "room_status_changes_tenant_id_room_id_rooms_tenant_id_id_fk" FOREIGN KEY ("tenant_id","room_id") REFERENCES "public"."rooms"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_status_changes" ADD CONSTRAINT "room_status_changes_tenant_id_stay_id_stays_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_id") REFERENCES "public"."stays"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_tenant_id_night_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","night_variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_tenant_id_room_type_id_room_types_tenant_id_id_fk" FOREIGN KEY ("tenant_id","room_type_id") REFERENCES "public"."room_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_beneficiaries" ADD CONSTRAINT "stay_beneficiaries_tenant_id_stay_id_stays_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_id") REFERENCES "public"."stays"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_deposits" ADD CONSTRAINT "stay_deposits_tenant_id_stay_id_stays_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_id") REFERENCES "public"."stays"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_deposits" ADD CONSTRAINT "stay_deposits_tenant_id_folio_id_folios_tenant_id_id_fk" FOREIGN KEY ("tenant_id","folio_id") REFERENCES "public"."folios"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_deposits" ADD CONSTRAINT "stay_deposits_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_deposits" ADD CONSTRAINT "stay_deposits_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_deposits" ADD CONSTRAINT "stay_deposits_tenant_id_cashier_session_id_cashier_sessions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","cashier_session_id") REFERENCES "public"."cashier_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_deposits" ADD CONSTRAINT "stay_deposits_tenant_id_payment_intent_id_payment_intents_tenant_id_id_fk" FOREIGN KEY ("tenant_id","payment_intent_id") REFERENCES "public"."payment_intents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stay_guests" ADD CONSTRAINT "stay_guests_tenant_id_stay_id_stays_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_id") REFERENCES "public"."stays"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_tenant_id_legal_entity_id_legal_entities_tenant_id_id_fk" FOREIGN KEY ("tenant_id","legal_entity_id") REFERENCES "public"."legal_entities"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_tenant_id_branch_id_room_id_rooms_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","room_id") REFERENCES "public"."rooms"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_tenant_id_room_type_id_room_types_tenant_id_id_fk" FOREIGN KEY ("tenant_id","room_type_id") REFERENCES "public"."room_types"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_tenant_id_customer_id_customers_tenant_id_id_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "folio_entries_night_once" ON "folio_entries" USING btree ("tenant_id","stay_id","night_date") WHERE "folio_entries"."kind" = 'ROOM_NIGHT';--> statement-breakpoint
CREATE UNIQUE INDEX "folio_entries_night_tax_once" ON "folio_entries" USING btree ("tenant_id","related_entry_id") WHERE "folio_entries"."kind" = 'ACCOMMODATION_TAX';--> statement-breakpoint
CREATE UNIQUE INDEX "folio_entries_reversal_once" ON "folio_entries" USING btree ("tenant_id","related_entry_id") WHERE "folio_entries"."kind" = 'NIGHT_REVERSAL';--> statement-breakpoint
CREATE UNIQUE INDEX "folio_entries_charge_once" ON "folio_entries" USING btree ("tenant_id","sale_id") WHERE "folio_entries"."kind" = 'CHARGE';--> statement-breakpoint
CREATE UNIQUE INDEX "folio_entries_charge_return_once" ON "folio_entries" USING btree ("tenant_id","sale_return_id") WHERE "folio_entries"."kind" = 'CHARGE_RETURN';--> statement-breakpoint
CREATE UNIQUE INDEX "folio_entries_payment_once" ON "folio_entries" USING btree ("tenant_id","folio_payment_id") WHERE "folio_entries"."folio_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folio_entries_deposit_once" ON "folio_entries" USING btree ("tenant_id","stay_deposit_id") WHERE "folio_entries"."stay_deposit_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "folio_entries_folio_idx" ON "folio_entries" USING btree ("tenant_id","folio_id");--> statement-breakpoint
CREATE INDEX "folio_entries_night_idx" ON "folio_entries" USING btree ("tenant_id","night_date") WHERE "folio_entries"."night_date" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "folio_payments_intent_once" ON "folio_payments" USING btree ("tenant_id","payment_intent_id") WHERE "folio_payments"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "folio_payments_folio_idx" ON "folio_payments" USING btree ("tenant_id","folio_id");--> statement-breakpoint
CREATE INDEX "folio_payments_session_idx" ON "folio_payments" USING btree ("tenant_id","cashier_session_id");--> statement-breakpoint
CREATE INDEX "folios_open_idx" ON "folios" USING btree ("tenant_id","legal_entity_id") WHERE "folios"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "room_blocks_room_idx" ON "room_blocks" USING btree ("tenant_id","room_id","starts_on");--> statement-breakpoint
CREATE INDEX "room_status_changes_room_idx" ON "room_status_changes" USING btree ("tenant_id","room_id","changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "room_types_code_active_unique" ON "room_types" USING btree ("tenant_id","code") WHERE "room_types"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_number_active_unique" ON "rooms" USING btree ("tenant_id","branch_id",lower("number")) WHERE "rooms"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stay_beneficiaries_stay_idx" ON "stay_beneficiaries" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stay_deposits_intent_once" ON "stay_deposits" USING btree ("tenant_id","payment_intent_id") WHERE "stay_deposits"."payment_intent_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stay_deposits_stay_idx" ON "stay_deposits" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stay_guests_one_primary" ON "stay_guests" USING btree ("tenant_id","stay_id") WHERE "stay_guests"."is_primary";--> statement-breakpoint
CREATE INDEX "stay_guests_stay_idx" ON "stay_guests" USING btree ("tenant_id","stay_id");--> statement-breakpoint
CREATE INDEX "stays_branch_dates_idx" ON "stays" USING btree ("tenant_id","branch_id","arrival_date");--> statement-breakpoint
CREATE INDEX "stays_in_house_idx" ON "stays" USING btree ("tenant_id","legal_entity_id") WHERE "stays"."status" = 'IN_HOUSE';--> statement-breakpoint
CREATE INDEX "stays_customer_idx" ON "stays" USING btree ("tenant_id","customer_id") WHERE "stays"."customer_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_folio_payment_id_folio_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","folio_payment_id") REFERENCES "public"."folio_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_tenant_id_stay_deposit_id_stay_deposits_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_deposit_id") REFERENCES "public"."stay_deposits"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_tenant_id_folio_payment_id_folio_payments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","folio_payment_id") REFERENCES "public"."folio_payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_tenant_id_folio_id_folios_tenant_id_id_fk" FOREIGN KEY ("tenant_id","folio_id") REFERENCES "public"."folios"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_tenant_id_stay_id_stays_tenant_id_id_fk" FOREIGN KEY ("tenant_id","stay_id") REFERENCES "public"."stays"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_entries_folio_once" ON "customer_credit_entries" USING btree ("tenant_id","folio_payment_id") WHERE "customer_credit_entries"."folio_payment_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_business_type_check" CHECK ("tenants"."business_type" IN ('RETAIL','RESTAURANT','HYBRID','GROCERY','SALON','LODGING'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_lodging_link" CHECK (("cash_movements"."type" = 'FOLIO_PAYMENT') = ("cash_movements"."folio_payment_id" IS NOT NULL) AND ("cash_movements"."type" IN ('DEPOSIT','DEPOSIT_REFUND')) = ("cash_movements"."stay_deposit_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_type_check" CHECK ("cash_movements"."type" IN ('OPENING_FLOAT','SALE','PAY_IN','PAY_OUT','REFUND','TIP','TIP_REFUND','TIP_PAYOUT','FOLIO_PAYMENT','DEPOSIT','DEPOSIT_REFUND'));--> statement-breakpoint
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sign_check" CHECK (("cash_movements"."type" IN ('PAY_OUT','REFUND','TIP_REFUND','TIP_PAYOUT','DEPOSIT_REFUND') AND "cash_movements"."amount" < 0) OR ("cash_movements"."type" IN ('PAY_IN','TIP','FOLIO_PAYMENT','DEPOSIT') AND "cash_movements"."amount" > 0) OR ("cash_movements"."type" IN ('OPENING_FLOAT','SALE') AND "cash_movements"."amount" >= 0));--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_kind_check" CHECK ("customer_credit_entries"."kind" IN ('RETURN','REDEEM','FOLIO_PAYMENT'));--> statement-breakpoint
ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "customer_credit_entries_link_check" CHECK (("customer_credit_entries"."kind" = 'RETURN' AND "customer_credit_entries"."amount" > 0 AND "customer_credit_entries"."sale_return_id" IS NOT NULL AND "customer_credit_entries"."sale_id" IS NULL AND "customer_credit_entries"."folio_payment_id" IS NULL)
       OR ("customer_credit_entries"."kind" = 'REDEEM' AND "customer_credit_entries"."amount" < 0 AND "customer_credit_entries"."sale_id" IS NOT NULL AND "customer_credit_entries"."sale_return_id" IS NULL AND "customer_credit_entries"."folio_payment_id" IS NULL)
       OR ("customer_credit_entries"."kind" = 'FOLIO_PAYMENT' AND "customer_credit_entries"."amount" < 0 AND "customer_credit_entries"."folio_payment_id" IS NOT NULL AND "customer_credit_entries"."sale_id" IS NULL AND "customer_credit_entries"."sale_return_id" IS NULL));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_consumer_check" CHECK (("payment_intents"."sale_id" IS NULL OR "payment_intents"."purpose" IN ('SALE','TIP')) AND ("payment_intents"."folio_id" IS NULL OR ("payment_intents"."purpose" = 'FOLIO' AND "payment_intents"."status" = 'SUCCEEDED')));--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_purpose_check" CHECK ("payment_intents"."purpose" IN ('SALE','TIP','FOLIO'));--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_refund_method_check" CHECK ("sale_returns"."refund_method" IN ('CASH','STORE_CREDIT','ROOM_CHARGE'));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_room_charge_check" CHECK (("sale_tenders"."method" = 'ROOM_CHARGE') = ("sale_tenders"."stay_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_method_check" CHECK ("sale_tenders"."method" IN ('CASH','CARD','QR','EWALLET','STORE_CREDIT','ROOM_CHARGE'));--> statement-breakpoint
ALTER TABLE "sale_tenders" ADD CONSTRAINT "sale_tenders_intent_check" CHECK (("sale_tenders"."method" IN ('CASH','STORE_CREDIT','ROOM_CHARGE')) = ("sale_tenders"."payment_intent_id" IS NULL));--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_source_check" CHECK ("journal_entries"."source_type" IN ('SALE','SALE_RETURN','GOODS_RECEIPT','SUPPLIER_RETURN','STOCK_ADJUSTMENT','STOCK_COUNT','TRANSFER_DISPATCH','TRANSFER_RECEIPT','CASH_MOVEMENT','CASH_VARIANCE','SUPPLIER_INVOICE','SUPPLIER_PAYMENT','SUPPLIER_NOTE','PACK_OPENING','SALE_TIP_REFUND','FOLIO_ENTRY','FOLIO_PAYMENT','STAY_DEPOSIT','MANUAL','REVERSAL'));