CREATE TABLE "catalog_versions" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "product_prices_schedule_idx" ON "product_prices" USING btree ("tenant_id","price_list_id","effective_from");