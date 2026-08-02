-- Better Auth cutover (libris-5ng.7).
--
-- Splits identity from credential. Until now `api_keys` WAS the user table and
-- seven columns pointed at it, so revoking a key cascade-deleted reading
-- history and one person could not hold two credentials. This migration
-- creates one `users` row per api key, repoints all seven columns at it, and
-- reshapes `api_keys` into the Better Auth apiKey plugin's model.
--
-- The whole thing is wrapped in a guard on the legacy `api_keys.key_hash`
-- column so it is safe to re-run: on an already-migrated database it does
-- nothing, and in particular it does not delete app passwords issued after the
-- cutover. Plain `IF NOT EXISTS` guards would not be enough — the statements
-- below reference columns that no longer exist afterwards, and only PL/pgSQL
-- defers resolving those to execution time.
--
-- NOT included here, deliberately:
--   * `service_credentials` is converted, not dropped. KoSync and OPDS still
--     read it; the DROP lands in libris-5ng.14 with its replacement.
--   * the api_key_id -> user_id column rename is libris-5ng.10.
DO $$
DECLARE
  admin_id text;
  orphan_count bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'api_keys'
       AND column_name = 'key_hash'
  ) THEN
    RAISE NOTICE 'auth cutover already applied, skipping';
    RETURN;
  END IF;

  -- 1. One user per api key.
  --
  -- The key's uuid is reused verbatim as the user's text id. That is what turns
  -- step 3 into a plain cast instead of a join, and it makes the mapping
  -- reproducible if the migration has to be rehearsed more than once.
  --
  -- Emails are placeholders: nothing in the old schema recorded a person. The
  -- real addresses come from the cutover mapping document (libris-5ng.2), which
  -- is applied by hand at cutover time. `.invalid` is the reserved TLD from
  -- RFC 2606, so these can never collide with or accidentally reach a real
  -- address. No `accounts` row is created — a bcrypt key hash is not a password
  -- hash and cannot become one, so every migrated user needs a password set by
  -- an admin before they can sign in.
  INSERT INTO users (id, name, email, email_verified, role, created_at, updated_at)
  SELECT k.id::text,
         k.label,
         k.id::text || '@migrated.invalid',
         false,
         CASE WHEN k.is_admin THEN 'admin' ELSE 'user' END,
         k.created_at,
         now()
    FROM api_keys k
      ON CONFLICT (id) DO NOTHING;

  -- 2. Drop the seven foreign keys.
  --
  -- Before anything is retyped, and before the legacy key rows are deleted:
  -- five of these cascade, so deleting api_keys with them still in place would
  -- take every row of reading history with it.
  ALTER TABLE books                    DROP CONSTRAINT IF EXISTS books_created_by_api_keys_id_fkey;
  ALTER TABLE reading_progress         DROP CONSTRAINT IF EXISTS reading_progress_api_key_id_api_keys_id_fkey;
  ALTER TABLE reading_progress_history DROP CONSTRAINT IF EXISTS reading_progress_history_api_key_id_api_keys_id_fkey;
  ALTER TABLE reading_aggregate        DROP CONSTRAINT IF EXISTS reading_aggregate_api_key_id_api_keys_id_fkey;
  ALTER TABLE service_credentials      DROP CONSTRAINT IF EXISTS service_credentials_api_key_id_api_keys_id_fkey;
  ALTER TABLE upload_registry          DROP CONSTRAINT IF EXISTS upload_registry_api_key_id_api_keys_id_fkey;
  ALTER TABLE hardcover_sync_log       DROP CONSTRAINT IF EXISTS hardcover_sync_log_api_key_id_api_keys_id_fkey;

  -- 3. uuid -> text. The values are already the new user ids.
  ALTER TABLE books                    ALTER COLUMN created_by TYPE text USING created_by::text;
  ALTER TABLE reading_progress         ALTER COLUMN api_key_id TYPE text USING api_key_id::text;
  ALTER TABLE reading_progress_history ALTER COLUMN api_key_id TYPE text USING api_key_id::text;
  ALTER TABLE reading_aggregate        ALTER COLUMN api_key_id TYPE text USING api_key_id::text;
  ALTER TABLE service_credentials      ALTER COLUMN api_key_id TYPE text USING api_key_id::text;
  ALTER TABLE upload_registry          ALTER COLUMN api_key_id TYPE text USING api_key_id::text;
  ALTER TABLE hardcover_sync_log       ALTER COLUMN api_key_id TYPE text USING api_key_id::text;

  -- 4. Every book gets an owner.
  --
  -- Books ingested by the watcher rather than uploaded have no creator. They go
  -- to the oldest admin, which is deterministic given the ids above.
  SELECT id INTO admin_id
    FROM users
   WHERE role = 'admin'
   ORDER BY created_at, id
   LIMIT 1;

  SELECT count(*) INTO orphan_count FROM books WHERE created_by IS NULL;

  IF orphan_count > 0 AND admin_id IS NULL THEN
    RAISE EXCEPTION
      'auth cutover: % book(s) have no owner and there is no admin user to assign them to. '
      'Mark at least one api_keys row is_admin before migrating.', orphan_count;
  END IF;

  IF orphan_count > 0 THEN
    UPDATE books SET created_by = admin_id WHERE created_by IS NULL;
    RAISE NOTICE 'auth cutover: assigned % orphaned book(s) to admin %', orphan_count, admin_id;
  END IF;

  ALTER TABLE books ALTER COLUMN created_by SET NOT NULL;

  -- created_by is NOT NULL now, so the partial index's predicate excludes
  -- nothing and only costs the planner a match.
  DROP INDEX IF EXISTS books_created_by_idx;
  CREATE INDEX books_created_by_idx ON books (created_by);

  -- 5. Reshape api_keys into the Better Auth apikey model.
  --
  -- The existing rows go: their key_hash values are bcrypt, and Better Auth
  -- hashes with SHA-256. There is no conversion, so every OPDS and e-reader
  -- credential must be reissued from the devices page. Re-pairing was accepted
  -- when the epic was planned.
  DELETE FROM api_keys;

  DROP INDEX IF EXISTS api_keys_key_prefix_idx;

  ALTER TABLE api_keys
    DROP COLUMN IF EXISTS key_prefix,
    DROP COLUMN IF EXISTS key_hash,
    DROP COLUMN IF EXISTS label,
    DROP COLUMN IF EXISTS is_admin,
    DROP COLUMN IF EXISTS last_used_at;

  -- Better Auth generates its own text ids, so the uuid default has to go
  -- before the type change — a gen_random_uuid() default cannot be cast to text.
  ALTER TABLE api_keys ALTER COLUMN id DROP DEFAULT;
  ALTER TABLE api_keys ALTER COLUMN id TYPE text USING id::text;

  -- created_at is kept from the legacy table; the other twenty are new.
  ALTER TABLE api_keys
    ADD COLUMN "config_id" text DEFAULT 'default' NOT NULL,
    ADD COLUMN "name" text,
    ADD COLUMN "start" text,
    ADD COLUMN "reference_id" text NOT NULL,
    ADD COLUMN "prefix" text,
    ADD COLUMN "key" text NOT NULL,
    ADD COLUMN "refill_interval" integer,
    ADD COLUMN "refill_amount" integer,
    ADD COLUMN "last_refill_at" timestamp with time zone,
    ADD COLUMN "enabled" boolean DEFAULT true,
    ADD COLUMN "rate_limit_enabled" boolean DEFAULT true,
    ADD COLUMN "rate_limit_time_window" integer DEFAULT 86400000,
    ADD COLUMN "rate_limit_max" integer DEFAULT 10,
    ADD COLUMN "request_count" integer DEFAULT 0,
    ADD COLUMN "remaining" integer,
    ADD COLUMN "last_request" timestamp with time zone,
    ADD COLUMN "expires_at" timestamp with time zone,
    ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN "permissions" text,
    ADD COLUMN "metadata" text;

  CREATE UNIQUE INDEX api_keys_key_uniq ON api_keys ("key");
  CREATE INDEX api_keys_reference_id_idx ON api_keys (reference_id);
  CREATE INDEX api_keys_config_id_idx ON api_keys (config_id);

  -- 6. Re-point every foreign key at users.
  --
  -- reading_progress and reading_aggregate now cascade from the PERSON, not
  -- from a credential — revoking an app password no longer erases reading
  -- history, which is the whole point of the split.
  --
  -- books.created_by is the exception: RESTRICT, because created_by is NOT NULL
  -- and neither deleting a user's books nor orphaning them is acceptable. The
  -- admin delete-user path reassigns first (libris-5ng.9).
  ALTER TABLE books
    ADD CONSTRAINT books_created_by_users_id_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT;
  ALTER TABLE reading_progress
    ADD CONSTRAINT reading_progress_api_key_id_users_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE reading_progress_history
    ADD CONSTRAINT reading_progress_history_api_key_id_users_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE reading_aggregate
    ADD CONSTRAINT reading_aggregate_api_key_id_users_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE service_credentials
    ADD CONSTRAINT service_credentials_api_key_id_users_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE upload_registry
    ADD CONSTRAINT upload_registry_api_key_id_users_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE hardcover_sync_log
    ADD CONSTRAINT hardcover_sync_log_api_key_id_users_id_fkey
    FOREIGN KEY (api_key_id) REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_reference_id_users_id_fkey
    FOREIGN KEY (reference_id) REFERENCES users(id) ON DELETE CASCADE;
END $$;
