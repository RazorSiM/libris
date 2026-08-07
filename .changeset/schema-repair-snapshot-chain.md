---
"@libris/api-hono": patch
---

Repair the drizzle-kit migration snapshot chain so `drizzle-kit generate` runs again.

The `user_id_rename` and `kosync_credentials` snapshots both recorded the origin
UUID as their parent instead of their real predecessor, which split the history
into three leaves. Plain `drizzle-kit generate` refused to run against that
("Non-commutative migrations detected -- Found 3 conflicts across 3 migrations")
and only produced a migration when `--ignore-conflicts` suppressed the check.

Only `prevIds` metadata changed; no applied `migration.sql` was touched, and the
generated SQL is unaffected. A new guard in `src/db/db.test.ts` fails if the
chain ever branches again.
