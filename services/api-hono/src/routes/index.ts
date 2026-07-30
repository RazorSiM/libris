import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { AppVariables } from "../context.js";
import pkg from "../../package.json" with { type: "json" };
import { authRoutes } from "./api/auth.js";
import { healthRoutes } from "./api/health.js";
import { settingsRoutes } from "./api/settings.js";
import { libraryRoutes } from "./api/library.js";
import { inboxRoutes } from "./api/inbox.js";
import { booksRoutes } from "./api/books.js";
import { seriesRoutes } from "./api/series.js";
import { searchRoutes } from "./api/search.js";
import { dashboardRoutes } from "./api/dashboard.js";
import { statsRoutes } from "./api/stats.js";
import { readingStatusRoutes } from "./api/reading-status.js";
import { credentialsRoutes } from "./api/credentials.js";
import { jobsRoutes } from "./api/jobs.js";
import { hardcoverRoutes } from "./api/hardcover.js";
import { createEventsRoutes } from "./api/events.js";
import { kosyncRoutes } from "./kosync/index.js";
import { opdsRootRoutes } from "./opds/index.js";
import { opdsBooksRoutes } from "./opds/books.js";
import { opdsAuthorsRoutes } from "./opds/authors.js";
import { opdsGenresRoutes } from "./opds/genres.js";
import { opdsSeriesRoutes } from "./opds/series.js";
import { opdsLanguagesRoutes } from "./opds/languages.js";
import { opdsNewRoutes } from "./opds/new.js";
import { opdsSearchRoutes } from "./opds/search.js";
import { opdsCoversRoutes } from "./opds/covers.js";
import { opdsDownloadRoutes } from "./opds/download.js";
import type { UpgradeWebSocket } from "hono/ws";
import { testRoutes } from "./__test/index.js";

export function createRouter(upgradeWebSocket: UpgradeWebSocket) {
  const router = new OpenAPIHono<{ Variables: AppVariables }>()
    // API routes
    .route("/api/auth", authRoutes)
    .route("/api/health", healthRoutes)
    .route("/api/settings", settingsRoutes)
    .route("/api/library", libraryRoutes)
    .route("/api/inbox", inboxRoutes)
    .route("/api/books", booksRoutes)
    .route("/api/series", seriesRoutes)
    .route("/api/search", searchRoutes)
    .route("/api/dashboard", dashboardRoutes)
    .route("/api/stats", statsRoutes)
    .route("/api/reading-status", readingStatusRoutes)
    .route("/api/credentials", credentialsRoutes)
    .route("/api/jobs", jobsRoutes)
    .route("/api/hardcover", hardcoverRoutes)
    .route("/api/events", createEventsRoutes(upgradeWebSocket))
    // KoSync protocol
    .route("/kosync", kosyncRoutes)
    // OPDS catalog
    .route("/opds", opdsRootRoutes)
    .route("/opds/books", opdsBooksRoutes)
    .route("/opds/authors", opdsAuthorsRoutes)
    .route("/opds/genres", opdsGenresRoutes)
    .route("/opds/series", opdsSeriesRoutes)
    .route("/opds/languages", opdsLanguagesRoutes)
    .route("/opds/new", opdsNewRoutes)
    .route("/opds/search", opdsSearchRoutes)
    .route("/opds/covers", opdsCoversRoutes)
    .route("/opds/download", opdsDownloadRoutes)
    // Test routes
    .route("/__test", testRoutes);

  // OpenAPI JSON endpoint
  router.doc("/_docs/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Libris API",
      description: "Self-hosted book management API",
      version: pkg.version,
    },
  });

  // Scalar API reference UI
  router.get(
    "/_docs/scalar",
    Scalar({
      url: "/_docs/openapi.json",
      theme: "laserwave",
    }),
  );

  return router;
}
