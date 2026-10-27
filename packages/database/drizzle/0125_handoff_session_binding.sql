ALTER TABLE "user_sessions" ADD COLUMN "bound_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "parent_family_id" uuid;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_bound_tenant_id_tenants_id_fk" FOREIGN KEY ("bound_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_sessions_parent_idx" ON "user_sessions" USING btree ("parent_family_id") WHERE "user_sessions"."parent_family_id" IS NOT NULL;