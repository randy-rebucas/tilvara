CREATE TABLE "email_change_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_change_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "email_change_tokens_email_format" CHECK ("email_change_tokens"."new_email" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_change_tokens" ADD CONSTRAINT "email_change_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_change_tokens_user_idx" ON "email_change_tokens" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_closed_disabled" CHECK ("users"."closed_at" IS NULL OR "users"."status" = 'DISABLED');