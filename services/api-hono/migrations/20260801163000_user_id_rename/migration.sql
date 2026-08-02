-- libris-5ng.10 — rename api_key_id to user_id on the six tables the cutover repointed.
--
-- The cutover (20260801115500_auth_cutover) changed what these columns POINT AT
-- — api_keys.id became users.id — but left their names alone to keep that
-- migration reviewable. This one finishes the rename, so a column called
-- user_id holds a user id.
--
-- Written by hand: drizzle-kit generate cannot produce it non-interactively
-- (it stops on a "created or renamed?" prompt), so the guarantee that this
-- matches src/db/schema.ts comes from the pushSchema drift check in
-- src/db/db.test.ts rather than from the generator.
--
-- RENAME COLUMN carries the data, the type, the NOT NULL and the foreign key
-- across untouched — but it does NOT rename the indexes and constraints built
-- on the column, so each of those is renamed explicitly below. Leaving them
-- would strand names like upload_registry_checksum_api_key_uniq on a user id.

ALTER TABLE reading_progress         RENAME COLUMN api_key_id TO user_id;--> statement-breakpoint
ALTER TABLE reading_progress_history RENAME COLUMN api_key_id TO user_id;--> statement-breakpoint
ALTER TABLE reading_aggregate        RENAME COLUMN api_key_id TO user_id;--> statement-breakpoint
ALTER TABLE service_credentials      RENAME COLUMN api_key_id TO user_id;--> statement-breakpoint
ALTER TABLE upload_registry          RENAME COLUMN api_key_id TO user_id;--> statement-breakpoint
ALTER TABLE hardcover_sync_log       RENAME COLUMN api_key_id TO user_id;--> statement-breakpoint

ALTER INDEX reading_progress_api_key_id_idx         RENAME TO reading_progress_user_id_idx;--> statement-breakpoint
ALTER INDEX reading_progress_history_api_key_id_idx RENAME TO reading_progress_history_user_id_idx;--> statement-breakpoint
ALTER INDEX reading_aggregate_api_key_id_idx        RENAME TO reading_aggregate_user_id_idx;--> statement-breakpoint
ALTER INDEX service_credentials_api_key_id_idx      RENAME TO service_credentials_user_id_idx;--> statement-breakpoint
ALTER INDEX hardcover_sync_log_api_key_id_idx       RENAME TO hardcover_sync_log_user_id_idx;--> statement-breakpoint

ALTER TABLE service_credentials RENAME CONSTRAINT service_credentials_service_api_key_uniq TO service_credentials_service_user_uniq;--> statement-breakpoint
ALTER TABLE upload_registry     RENAME CONSTRAINT upload_registry_checksum_api_key_uniq   TO upload_registry_checksum_user_uniq;--> statement-breakpoint

ALTER TABLE reading_progress         RENAME CONSTRAINT reading_progress_api_key_id_users_id_fkey         TO reading_progress_user_id_users_id_fkey;--> statement-breakpoint
ALTER TABLE reading_progress_history RENAME CONSTRAINT reading_progress_history_api_key_id_users_id_fkey TO reading_progress_history_user_id_users_id_fkey;--> statement-breakpoint
ALTER TABLE reading_aggregate        RENAME CONSTRAINT reading_aggregate_api_key_id_users_id_fkey        TO reading_aggregate_user_id_users_id_fkey;--> statement-breakpoint
ALTER TABLE service_credentials      RENAME CONSTRAINT service_credentials_api_key_id_users_id_fkey      TO service_credentials_user_id_users_id_fkey;--> statement-breakpoint
ALTER TABLE upload_registry          RENAME CONSTRAINT upload_registry_api_key_id_users_id_fkey          TO upload_registry_user_id_users_id_fkey;--> statement-breakpoint
ALTER TABLE hardcover_sync_log       RENAME CONSTRAINT hardcover_sync_log_api_key_id_users_id_fkey       TO hardcover_sync_log_user_id_users_id_fkey;
