CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TYPE "book_status" AS ENUM('inbox', 'review', 'organized');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL UNIQUE,
	"label" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"book_id" uuid NOT NULL,
	"format" text NOT NULL,
	"original_name" text NOT NULL,
	"storage_path" text,
	"inbox_path" text,
	"file_size" bigint DEFAULT 0 NOT NULL,
	"checksum" text,
	"content_hash" text,
	"original_content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "book_metadata_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"book_id" uuid NOT NULL,
	"source" text NOT NULL,
	"raw_response" jsonb,
	"normalized" jsonb DEFAULT '{}' NOT NULL,
	"confidence" numeric(5,4) DEFAULT '0' NOT NULL,
	"selected_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "book_candidates_book_source_uniq" UNIQUE("book_id","source")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"status" "book_status" DEFAULT 'inbox'::"book_status" NOT NULL,
	"title" text,
	"author" text,
	"isbn_10" text,
	"isbn_13" text,
	"publisher" text,
	"published_year" integer,
	"language" text,
	"description" text,
	"cover_url" text,
	"cover_path" text,
	"page_count" integer,
	"series" text,
	"series_index" real,
	"genres" text[] DEFAULT '{}'::text[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"hardcover_book_id" integer,
	"hardcover_edition_id" integer,
	"created_by" uuid,
	"possible_duplicate_of" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" tsvector
);
--> statement-breakpoint
CREATE TABLE "hardcover_sync_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"book_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"hardcover_user_book_id" integer,
	"hardcover_read_id" integer,
	"last_status" text,
	"last_progress" numeric(5,4),
	"last_rating" numeric(3,1),
	"last_synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hardcover_sync_log_user_book_uniq" UNIQUE("api_key_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "reading_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"book_id" uuid,
	"api_key_id" uuid NOT NULL,
	"document" text NOT NULL,
	"device" text NOT NULL,
	"device_id" text,
	"progress" text NOT NULL,
	"percentage" numeric(5,4) DEFAULT '0' NOT NULL,
	"timestamp" bigint DEFAULT 0 NOT NULL,
	"raw_payload" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_progress_user_document_device_uniq" UNIQUE("api_key_id","document","device")
);
--> statement-breakpoint
CREATE TABLE "reading_progress_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"book_id" uuid,
	"api_key_id" uuid,
	"document" text NOT NULL,
	"device" text NOT NULL,
	"progress" text NOT NULL,
	"percentage" numeric(5,4) DEFAULT '0' NOT NULL,
	"timestamp" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"service" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_credentials_service_api_key_uniq" UNIQUE("service","api_key_id")
);
--> statement-breakpoint
CREATE TABLE "upload_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"checksum" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_registry_checksum_api_key_uniq" UNIQUE("checksum","api_key_id")
);
--> statement-breakpoint
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys" ("key_prefix");--> statement-breakpoint
CREATE INDEX "book_files_book_id_idx" ON "book_files" ("book_id");--> statement-breakpoint
CREATE INDEX "book_files_checksum_idx" ON "book_files" ("checksum");--> statement-breakpoint
CREATE INDEX "book_files_content_hash_idx" ON "book_files" ("content_hash");--> statement-breakpoint
CREATE INDEX "book_files_original_content_hash_idx" ON "book_files" ("original_content_hash");--> statement-breakpoint
CREATE INDEX "book_metadata_candidates_book_id_idx" ON "book_metadata_candidates" ("book_id");--> statement-breakpoint
CREATE INDEX "books_status_created_at_idx" ON "books" ("status","created_at");--> statement-breakpoint
CREATE INDEX "books_isbn13_idx" ON "books" ("isbn_13");--> statement-breakpoint
CREATE INDEX "books_search_vector_idx" ON "books" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "books_title_trgm_idx" ON "books" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "books_author_trgm_idx" ON "books" USING gin ("author" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "books_series_idx" ON "books" ("series") WHERE series IS NOT NULL;--> statement-breakpoint
CREATE INDEX "books_possible_duplicate_of_idx" ON "books" ("possible_duplicate_of") WHERE possible_duplicate_of IS NOT NULL;--> statement-breakpoint
CREATE INDEX "books_created_by_idx" ON "books" ("created_by") WHERE created_by IS NOT NULL;--> statement-breakpoint
CREATE INDEX "books_hardcover_book_id_idx" ON "books" ("hardcover_book_id") WHERE hardcover_book_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "books_series_series_index_uniq" ON "books" ("series","series_index") WHERE series IS NOT NULL AND series_index IS NOT NULL;--> statement-breakpoint
CREATE INDEX "hardcover_sync_log_status_idx" ON "hardcover_sync_log" ("last_status");--> statement-breakpoint
CREATE INDEX "hardcover_sync_log_last_synced_at_idx" ON "hardcover_sync_log" ("last_synced_at");--> statement-breakpoint
CREATE INDEX "hardcover_sync_log_api_key_id_idx" ON "hardcover_sync_log" ("api_key_id");--> statement-breakpoint
CREATE INDEX "reading_progress_device_idx" ON "reading_progress" ("device");--> statement-breakpoint
CREATE INDEX "reading_progress_book_id_idx" ON "reading_progress" ("book_id");--> statement-breakpoint
CREATE INDEX "reading_progress_api_key_id_idx" ON "reading_progress" ("api_key_id");--> statement-breakpoint
CREATE INDEX "reading_progress_history_document_created_at_idx" ON "reading_progress_history" ("document","created_at");--> statement-breakpoint
CREATE INDEX "reading_progress_history_created_at_idx" ON "reading_progress_history" ("created_at");--> statement-breakpoint
CREATE INDEX "reading_progress_history_book_id_idx" ON "reading_progress_history" ("book_id");--> statement-breakpoint
CREATE INDEX "reading_progress_history_api_key_id_idx" ON "reading_progress_history" ("api_key_id");--> statement-breakpoint
CREATE INDEX "service_credentials_api_key_id_idx" ON "service_credentials" ("api_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_credentials_service_username_uniq" ON "service_credentials" ("service","username");--> statement-breakpoint
ALTER TABLE "book_files" ADD CONSTRAINT "book_files_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "book_metadata_candidates" ADD CONSTRAINT "book_metadata_candidates_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_created_by_api_keys_id_fkey" FOREIGN KEY ("created_by") REFERENCES "api_keys"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "books" ADD CONSTRAINT "books_possible_duplicate_of_books_id_fkey" FOREIGN KEY ("possible_duplicate_of") REFERENCES "books"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "hardcover_sync_log" ADD CONSTRAINT "hardcover_sync_log_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "hardcover_sync_log" ADD CONSTRAINT "hardcover_sync_log_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reading_progress" ADD CONSTRAINT "reading_progress_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "reading_progress_history" ADD CONSTRAINT "reading_progress_history_book_id_books_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "reading_progress_history" ADD CONSTRAINT "reading_progress_history_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "service_credentials" ADD CONSTRAINT "service_credentials_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "upload_registry" ADD CONSTRAINT "upload_registry_api_key_id_api_keys_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE OR REPLACE FUNCTION books_search_vector_update() RETURNS trigger AS $fn$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.author, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.series, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(array_to_string(NEW.genres, ' '), '')), 'C');
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE TRIGGER books_search_vector_trigger
  BEFORE INSERT OR UPDATE ON "books"
  FOR EACH ROW EXECUTE FUNCTION books_search_vector_update();