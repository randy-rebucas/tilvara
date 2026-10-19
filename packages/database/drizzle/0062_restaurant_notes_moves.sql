CREATE TABLE "order_course_notes" (
	"tenant_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"course" integer NOT NULL,
	"note" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_course_notes_tenant_id_order_id_course_pk" PRIMARY KEY("tenant_id","order_id","course"),
	CONSTRAINT "order_course_notes_course_check" CHECK ("order_course_notes"."course" BETWEEN 1 AND 9),
	CONSTRAINT "order_course_notes_note_check" CHECK (length(trim("order_course_notes"."note")) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "order_item_moves" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"from_order_id" uuid NOT NULL,
	"to_order_id" uuid NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_item_moves_tenant_id_id_unique" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "kitchen_tickets" ADD COLUMN "course_note" text;--> statement-breakpoint
ALTER TABLE "order_course_notes" ADD CONSTRAINT "order_course_notes_tenant_id_branch_id_order_id_restaurant_orders_tenant_id_branch_id_id_fk" FOREIGN KEY ("tenant_id","branch_id","order_id") REFERENCES "public"."restaurant_orders"("tenant_id","branch_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_moves" ADD CONSTRAINT "order_item_moves_tenant_id_from_order_id_restaurant_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","from_order_id") REFERENCES "public"."restaurant_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_moves" ADD CONSTRAINT "order_item_moves_tenant_id_to_order_id_restaurant_orders_tenant_id_id_fk" FOREIGN KEY ("tenant_id","to_order_id") REFERENCES "public"."restaurant_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_item_moves_item_idx" ON "order_item_moves" USING btree ("tenant_id","item_id","moved_at");