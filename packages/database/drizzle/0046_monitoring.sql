CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	"version" text,
	CONSTRAINT "worker_heartbeats_id_length" CHECK (length("worker_heartbeats"."worker_id") BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE INDEX "outbox_events_dead_idx" ON "outbox_events" USING btree ("created_at") WHERE "outbox_events"."status" = 'DEAD';--> statement-breakpoint
CREATE INDEX "cashier_sessions_awaiting_idx" ON "cashier_sessions" USING btree ("closed_at") WHERE "cashier_sessions"."status" = 'CLOSED';--> statement-breakpoint
CREATE INDEX "payment_intents_unresolved_idx" ON "payment_intents" USING btree ("created_at") WHERE "payment_intents"."status" IN ('PROCESSING','UNKNOWN');--> statement-breakpoint
CREATE INDEX "terminal_transactions_quarantined_idx" ON "terminal_transactions" USING btree ("received_at") WHERE "terminal_transactions"."status" = 'QUARANTINED';