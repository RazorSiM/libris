import { drizzle } from "drizzle-orm/postgres-js";
import { relations } from "./relations";

export type Db = ReturnType<typeof createDb>;

/**
 * `relations` is the only schema input the driver takes.
 *
 * Drizzle 1.0.0-rc dropped relational-queries v1: `DrizzlePgConfig` now Omits
 * `schema`, and the driver's first type parameter is the relations config, not
 * the schema. `defineRelations(schema, ...)` already carries every table, so
 * `db.query.*` still resolves — but `db._.fullSchema` no longer exists. Code
 * that needs the raw table objects must import `./schema` directly (see the
 * explicit `schema` passed to `drizzleAdapter` in `src/lib/auth.ts`).
 */
export function createDb(connectionString: string) {
  return drizzle({
    connection: {
      url: connectionString,
      max: 20,
      idle_timeout: 30,
      max_lifetime: 60 * 30, // 30 minutes
    },
    relations,
  });
}
