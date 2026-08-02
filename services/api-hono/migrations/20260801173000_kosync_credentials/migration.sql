-- libris-5ng.14 — move KoSync onto its own table with a sha256-indexed secret.
--
-- Written by hand for the same reason as the other migrations in this epic:
-- drizzle-kit generate cannot run non-interactively here. The guarantee that
-- this matches src/db/schema.ts is the pushSchema drift check in
-- src/db/db.test.ts.
--
-- No data is carried over, and it could not be: the old rows hold
-- bcrypt(md5(password)) and the new column holds sha256 of the wire value.
-- A bcrypt digest cannot be converted into a sha256 one, so KoSync credentials
-- are regenerated — already the accepted position for this cutover, since api
-- key hashes have the same problem.
--
-- service_credentials SURVIVES: it also stores the Hardcover token, which is
-- sealed with web crypto and unrelated to KoSync. Only the kosync rows go.

CREATE TABLE kosync_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  username text NOT NULL,
  secret_hash text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

ALTER TABLE kosync_credentials
  ADD CONSTRAINT kosync_credentials_user_id_users_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX kosync_credentials_username_uniq ON kosync_credentials (username);--> statement-breakpoint
CREATE UNIQUE INDEX kosync_credentials_user_id_uniq ON kosync_credentials (user_id);--> statement-breakpoint

-- The kosync rows are dead weight now: nothing reads them, and leaving them
-- behind would let a stale (service, username) unique collide with a future one.
DELETE FROM service_credentials WHERE service = 'kosync';--> statement-breakpoint

-- OPDS moved to Better Auth api keys in libris-5ng.12, so those rows are dead too.
DELETE FROM service_credentials WHERE service = 'opds';
