import type { createRouter } from "./routes/index.js";

/**
 * The router type for use with hono/client's `hc`.
 * Exported separately from the app to avoid pulling in server internals
 * (#db, bootstrap, etc.) that can't be resolved from consumer packages.
 */
export type AppType = ReturnType<typeof createRouter>;
