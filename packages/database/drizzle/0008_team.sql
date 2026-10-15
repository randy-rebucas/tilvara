CREATE TABLE "member_invitations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"roles" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_invitations_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "member_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "member_invitations_status_check" CHECK ("member_invitations"."status" IN ('PENDING','ACCEPTED','REVOKED')),
	CONSTRAINT "member_invitations_roles_nonempty" CHECK (jsonb_typeof("member_invitations"."roles") = 'array' AND jsonb_array_length("member_invitations"."roles") > 0)
);
--> statement-breakpoint
ALTER TABLE "member_invitations" ADD CONSTRAINT "member_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_invitations_one_pending" ON "member_invitations" USING btree ("tenant_id",lower("email")) WHERE "member_invitations"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "member_invitations_tenant_idx" ON "member_invitations" USING btree ("tenant_id","created_at");