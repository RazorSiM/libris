CREATE TABLE "reading_aggregate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"api_key_id" uuid NOT NULL,
	"book_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_aggregate_user_book_uniq" UNIQUE("api_key_id","book_id")
);
--> statement-breakpoint
CREATE INDEX "reading_aggregate_book_id_idx" ON "reading_aggregate" ("book_id");--> statement-breakpoint
CREATE INDEX "reading_aggregate_api_key_id_idx" ON "reading_aggregate" ("api_key_id");--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD CONSTRAINT "reading_aggregate_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reading_aggregate" ADD CONSTRAINT "reading_aggregate_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL;