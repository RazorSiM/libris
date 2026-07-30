ALTER TABLE "reading_aggregate" ADD COLUMN "external_status" "reading_status";--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD COLUMN "external_status_synced_at" timestamp with time zone;