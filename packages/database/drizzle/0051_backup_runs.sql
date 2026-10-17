CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"backup_file" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"migrations" integer NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "backup_runs_kind_check" CHECK ("backup_runs"."kind" IN ('BACKUP','RESTORE_DRILL')),
	CONSTRAINT "backup_runs_file_length" CHECK (length("backup_runs"."backup_file") BETWEEN 1 AND 200),
	CONSTRAINT "backup_runs_sha256_format" CHECK ("backup_runs"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "backup_runs_order" CHECK ("backup_runs"."finished_at" >= "backup_runs"."started_at")
);
--> statement-breakpoint
CREATE INDEX "backup_runs_kind_finished_idx" ON "backup_runs" USING btree ("kind","finished_at");