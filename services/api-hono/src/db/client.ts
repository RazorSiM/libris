import { drizzle } from "drizzle-orm/postgres-js";
import { relations } from "./relations";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(connectionString: string) {
  return drizzle({
    connection: {
      url: connectionString,
      max: 20,
      idle_timeout: 30,
      max_lifetime: 60 * 30, // 30 minutes
    },
    schema,
    relations,
  });
}
