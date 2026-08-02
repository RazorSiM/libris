import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

// Load .env.test if present, otherwise root .env.
// dotenv does not override existing env vars, so values set by
// scripts/test-e2e.sh (via export) always take precedence.
const root = resolve(import.meta.dirname!, "../..");
const envFile = existsSync(resolve(root, ".env.test"))
  ? resolve(root, ".env.test")
  : resolve(root, ".env");
config({ path: envFile });

const API_PORT = 3000;
const WEB_PORT = 3100;

// In CI, Hono serves the SPA (like production) — single origin on API_PORT.
// In dev, the web dev server runs on WEB_PORT with a proxy to API_PORT.
const basePort = process.env.CI ? API_PORT : WEB_PORT;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // All tests share a single database — workers: 1 prevents in-process race conditions.
  // Parallelism via --shard requires multiple CI runners (one runner queues shards serially).
  workers: 1,
  reporter: process.env.CI
    ? [["list"], ["github"], ["html", { open: "never" }]]
    : [["list"], ["html"]],
  outputDir: "test-results",

  use: {
    baseURL: `http://localhost:${basePort}`,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "user-setup",
      testMatch: /user-auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/user.json",
      },
      // Everything except first-run setup, which has to come after this whole
      // project — see below.
      testIgnore: /first-run-setup\.spec\.ts/,
      dependencies: ["setup", "user-setup"],
    },
    {
      /**
       * First-run setup, alone and last.
       *
       * It deletes every account to get the empty install it is testing, which
       * revokes the app passwords, invalidates the ids in E2E_ADMIN_USER_ID and
       * friends, and kills the cookies in .auth/*.json. Nothing that depends on
       * those can follow it.
       *
       * `dependencies: ["chromium"]` is what enforces that: Playwright will not
       * start this project until chromium has finished. Without it the spec
       * sorts alphabetically among the rest and every spec after it runs signed
       * out.
       *
       * No storageState: a first-run visitor has no session by definition.
       */
      name: "first-run",
      testMatch: /first-run-setup\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["chromium"],
    },
  ],

  webServer: process.env.CI
    ? [
        {
          // CI: Hono serves both API and SPA from ./public (like production)
          command: "node services/api-hono/dist/index.mjs",
          cwd: "../..",
          url: `http://localhost:${API_PORT}/api/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { PORT: String(API_PORT) },
        },
      ]
    : [
        {
          // E2E_DOCKER: tsx without watch to avoid restart races on port bind
          command: process.env.E2E_DOCKER
            ? "pnpm --filter @libris/api-hono exec tsx src/index.ts"
            : "pnpm --filter @libris/api-hono run dev",
          cwd: "../..",
          url: `http://localhost:${API_PORT}/api/health`,
          reuseExistingServer: !process.env.E2E_DOCKER,
          timeout: 60_000,
        },
        {
          // Dev: Vite dev server with proxy to API. Invoked through `vp run`
          // because the `dev` task lives in apps/web/vite.config.ts — there is
          // no `dev` script in apps/web/package.json for `pnpm run` to find.
          command: "pnpm exec vp run -F @libris/web dev",
          cwd: "../..",
          url: `http://localhost:${WEB_PORT}`,
          reuseExistingServer: !process.env.E2E_DOCKER,
          timeout: 60_000,
        },
      ],

  globalSetup: "./global-setup.ts",
});
