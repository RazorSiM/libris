CREATE TYPE "reading_status" AS ENUM('unread', 'reading', 'finished', 'paused');--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD COLUMN "manual_status" "reading_status";--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD COLUMN "manual_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD COLUMN "manual_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD COLUMN "manual_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD COLUMN "manual_set_at" timestamp with time zone;