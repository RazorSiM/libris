---
"@libris/api-hono": patch
---

Rename the NOT NULL constraints left named after `api_key_id`

PostgreSQL 18 gives NOT NULL constraints real entries in `pg_constraint`, named
after the column as declared. `ALTER TABLE ... RENAME COLUMN` does not rename
them, so a database first created on PG18 replays the migration chain, declares
these columns as `api_key_id`, renames them to `user_id`, and is left with names
like `reading_progress_api_key_id_not_null` on a column called `user_id`.

A migration renames the five affected constraints where they exist. On PG17 —
which every supported deployment runs — NOT NULL constraints have no catalog
name, nothing matches, and the migration is a verified no-op. Databases carried
onto PG18 by dump/restore are also unaffected, since the column is declared
under its current name.

Surfaced by the PGlite 0.4 -> 0.5 upgrade, which moved the test harness from
PostgreSQL 17 to 18.
