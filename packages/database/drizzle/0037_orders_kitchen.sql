ALTER TABLE "kitchen_stations" ADD CONSTRAINT "kitchen_stations_branch_id_unique" UNIQUE("tenant_id","branch_id","id");--> statement-breakpoint
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_branch_id_unique" UNIQUE("tenant_id","branch_id","id");--> statement-breakpoint
CREATE TABLE "kitchen_tickets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"ticket_number" bigint NOT NULL,
	"course" integer NOT NULL,
	"fired_by" uuid NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bumped_at" timestamp with time zone,
	"bumped_by" uuid,
	CONSTRAINT "kitchen_tickets_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "kitchen_tickets_number_unique" UNIQUE("tenant_id","branch_id","ticket_number"),
	CONSTRAINT "kitchen_tickets_course_check" CHECK ("kitchen_tickets"."course" BETWEEN 1 AND 9)
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"parent_item_id" uuid,
	"kind" text NOT NULL,
	"variant_id" uuid,
	"modifier_option_id" uuid,
	"menu_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"course" integer DEFAULT 1 NOT NULL,
	"seat" integer,
	"note" text,
	"station_code" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"kitchen_ticket_id" uuid,
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fired_at" timestamp with time zone,
	"prep_started_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"served_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"waste_adjustment_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "order_items_kind_check" CHECK ("order_items"."kind" IN ('ITEM','MODIFIER')),
	CONSTRAINT "order_items_shape_check" CHECK (("order_items"."kind" = 'ITEM' AND "order_items"."parent_item_id" IS NULL AND "order_items"."modifier_option_id" IS NULL AND "order_items"."variant_id" IS NOT NULL)
      OR ("order_items"."kind" = 'MODIFIER' AND "order_items"."parent_item_id" IS NOT NULL AND "order_items"."modifier_option_id" IS NOT NULL)),
	CONSTRAINT "order_items_status_check" CHECK ("order_items"."status" IN ('PENDING','FIRED','IN_PREP','READY','SERVED','VOIDED')),
	CONSTRAINT "order_items_quantity_check" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_course_check" CHECK ("order_items"."course" BETWEEN 1 AND 9),
	CONSTRAINT "order_items_seat_check" CHECK ("order_items"."seat" IS NULL OR "order_items"."seat" BETWEEN 1 AND 500),
	CONSTRAINT "order_items_fired_check" CHECK (("order_items"."status" = 'PENDING') = ("order_items"."fired_at" IS NULL)),
	CONSTRAINT "order_items_void_check" CHECK (("order_items"."status" = 'VOIDED') = ("order_items"."voided_at" IS NOT NULL) AND ("order_items"."voided_at" IS NULL OR length(trim(coalesce("order_items"."void_reason", ''))) > 0)),
	CONSTRAINT "order_items_station_check" CHECK ("order_items"."station_code" IS NULL OR "order_items"."station_code" ~ '^[A-Z][A-Z0-9_]{0,15}$')
);
--> statement-breakpoint
CREATE TABLE "restaurant_orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"order_number" bigint NOT NULL,
	"order_type" text NOT NULL,
	"table_id" uuid,
	"guest_count" integer,
	"customer_name" text,
	"note" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"merged_into_id" uuid,
	"close_reason" text,
	"opened_by" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_orders_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "restaurant_orders_branch_id_unique" UNIQUE("tenant_id","branch_id","id"),
	CONSTRAINT "restaurant_orders_number_unique" UNIQUE("tenant_id","branch_id","order_number"),
	CONSTRAINT "restaurant_orders_type_check" CHECK ("restaurant_orders"."order_type" IN ('DINE_IN','TAKEAWAY')),
	CONSTRAINT "restaurant_orders_status_check" CHECK ("restaurant_orders"."status" IN ('OPEN','BILLED','SETTLED','CANCELLED','MERGED')),
	CONSTRAINT "restaurant_orders_table_check" CHECK (("restaurant_orders"."order_type" = 'DINE_IN') = ("restaurant_orders"."table_id" IS NOT NULL)),
	CONSTRAINT "restaurant_orders_merged_check" CHECK (("restaurant_orders"."status" = 'MERGED') = ("restaurant_orders"."merged_into_id" IS NOT NULL) AND "restaurant_orders"."merged_into_id" IS DISTINCT FROM "restaurant_orders"."id"),
	CONSTRAINT "restaurant_orders_guests_check" CHECK ("restaurant_orders"."guest_count" IS NULL OR "restaurant_orders"."guest_count" BETWEEN 1 AND 500),
	CONSTRAINT "restaurant_orders_cancel_reason" CHECK ("restaurant_orders"."status" <> 'CANCELLED' OR length(trim(coalesce("restaurant_orders"."close_reason", ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_tenant_id_branch_id_order_id_restaurant_orders_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","order_id") REFERENCES "public"."restaurant_orders"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD CONSTRAINT "kitchen_tickets_tenant_id_branch_id_station_id_kitchen_stations_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","station_id") REFERENCES "public"."kitchen_stations"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_order_id_restaurant_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."restaurant_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_parent_item_id_order_items_tenant_id_id_fk" FOREIGN KEY ("tenant_id","parent_item_id") REFERENCES "public"."order_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_variant_id_product_variants_tenant_id_id_fk" FOREIGN KEY ("tenant_id","variant_id") REFERENCES "public"."product_variants"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_modifier_option_id_modifier_options_tenant_id_id_fk" FOREIGN KEY ("tenant_id","modifier_option_id") REFERENCES "public"."modifier_options"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_menu_version_id_menu_versions_tenant_id_id_fk" FOREIGN KEY ("tenant_id","menu_version_id") REFERENCES "public"."menu_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_kitchen_ticket_id_kitchen_tickets_tenant_id_id_fk" FOREIGN KEY ("tenant_id","kitchen_ticket_id") REFERENCES "public"."kitchen_tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_waste_adjustment_id_stock_adjustments_tenant_id_id_fk" FOREIGN KEY ("tenant_id","waste_adjustment_id") REFERENCES "public"."stock_adjustments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_tenant_id_branch_id_branches_tenant_id_id_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_tenant_id_branch_id_table_id_restaurant_tables_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","table_id") REFERENCES "public"."restaurant_tables"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_tenant_id_branch_id_merged_into_id_restaurant_orders_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","merged_into_id") REFERENCES "public"."restaurant_orders"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kitchen_tickets_station_idx" ON "kitchen_tickets" USING btree ("tenant_id","station_id","fired_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("tenant_id","order_id");--> statement-breakpoint
CREATE INDEX "order_items_ticket_idx" ON "order_items" USING btree ("tenant_id","kitchen_ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "restaurant_orders_table_live_unique" ON "restaurant_orders" USING btree ("tenant_id","table_id") WHERE "restaurant_orders"."status" IN ('OPEN','BILLED') AND "restaurant_orders"."table_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "restaurant_orders_branch_status_idx" ON "restaurant_orders" USING btree ("tenant_id","branch_id","status");
