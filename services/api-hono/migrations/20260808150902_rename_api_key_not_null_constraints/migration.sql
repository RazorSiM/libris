-- Drop the `api_key_id` spelling from the NOT NULL constraint names left over
-- by the user_id rename.
--
-- PostgreSQL 18 gives NOT NULL constraints real entries in pg_constraint, with
-- names derived from the column at the time it was declared. Postgres 17 and
-- earlier stored them only as pg_attribute.attnotnull, with no name to rename.
--
-- `20260801163000_user_id_rename` renamed api_key_id -> user_id, but
-- ALTER TABLE ... RENAME COLUMN does not rename the constraints derived from
-- the old column name. So a database first created on PG18 -- which replays
-- these migrations from the start, declaring the column as api_key_id before
-- renaming it -- ends up with `reading_progress_api_key_id_not_null` sitting on
-- a column called user_id. That is exactly the stale signpost the rename
-- migration set out to avoid. A database carried onto PG18 by dump/restore is
-- unaffected: the column is declared under its current name, so the generated
-- constraint name already says user_id.
--
-- On PG17 -- what every supported deployment runs today -- contype 'n' matches
-- nothing, the loop body never executes, and this migration is a no-op. It is
-- here so that a fresh install on PG18 does not inherit the stale names.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl,
           c.conname AS old_name,
           replace(c.conname, '_api_key_id_not_null', '_user_id_not_null') AS new_name
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.contype = 'n'
       AND n.nspname = current_schema()
       AND c.conname LIKE '%\_api\_key\_id\_not\_null'
  LOOP
    EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
  END LOOP;
END $$;
