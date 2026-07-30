import { defineConfig } from "drizzle-kit";
import { resolveDatabaseUrl } from "./src/lib/resolve-database-url";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveDatabaseUrl() ?? "postgresql://localhost/books",
  },
});
