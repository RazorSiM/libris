import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { resolveDatabaseUrl } from "../src/lib/resolve-database-url";

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  console.error(
    "Database config missing: set DATABASE_URL, or POSTGRES_{HOST,USER,PASSWORD,DB} (POSTGRES_PORT defaults to 5432).",
  );
  process.exit(1);
}

const confirmed = process.argv.includes("--yes") || process.argv.includes("-y");

if (!confirmed) {
  const redacted = databaseUrl.replace(/\/\/[^@]+@/, "//***@");
  console.error(
    `Refusing to wipe database without --yes.\nTarget: ${redacted}\nRun again with --yes to proceed.`,
  );
  process.exit(1);
}

const db = drizzle(databaseUrl);

try {
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`DROP SCHEMA public CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  console.log("Database reset: public + drizzle schemas dropped and recreated.");
  console.log("Next run of the API will re-apply migrations from scratch.");
} finally {
  await db.$client.end();
}
