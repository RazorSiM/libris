import { defineConfig } from "vite-plus";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    format: "esm",
    // Matches the runtime major in .node-version / engines.node and the
    // node:*-slim base in the Dockerfile — keep the three in step so tsdown
    // doesn't down-level syntax the deployed runtime supports natively.
    target: "node26",
    outDir: "dist",
    clean: true,
    deps: {
      // Bundle all dependencies so the Docker runner is self-contained
      alwaysBundle: [/.*/],
      neverBundle: [
        "@electric-sql/pglite",
        "@loglayer/transport-pretty-terminal",
        "better-sqlite3",
        "bun:sqlite",
        "keypress",
      ],
    },
  },

  resolve: {
    alias: [
      { find: /^#db$/, replacement: resolve(here, "src/db/index.ts") },
      { find: /^#db\/(.*)$/, replacement: resolve(here, "src/db/$1") },
    ],
  },

  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "pglite://",
      REDIS_URL: "redis://localhost:6379",
      LIBRIS_INBOX_PATH: "/tmp/libris-test-inbox",
      LIBRIS_LIBRARY_PATH: "/tmp/libris-test-library",
      API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
      KOSYNC_USERNAME: "testuser",
      KOSYNC_PASSWORD_HASH: "$2b$10$Awb/V5CEX/pMaJHmAetwluMtevWSFx3mR3q5vNJMBQa4cK/HtGwJ2",
    },
  },

  // All scripts live here as Vite Task definitions so that dependsOn replaces
  // the old `pre*` + `pnpm run` chains. `pnpm run` inside a script bypasses the
  // task graph (separate process, no cache, no inlining); `vp run` uses
  // dependsOn and gets compound-command splitting + per-step caching for free.
  // See docs guide/run.md §Task Dependencies and cache.md §When Is Caching Enabled.
  run: {
    tasks: {
      "generate:version": {
        // Reads only package.json; writes src/generated/version.ts. Use
        // explicit input so auto-tracking doesn't pick up the generated
        // file and self-invalidate.
        command: "tsx scripts/generate-version.ts",
        input: ["package.json", "scripts/generate-version.ts"],
      },
      dev: {
        command: "dotenv -e ../../.env -- tsx watch src/index.ts",
        dependsOn: ["generate:version"],
        cache: false,
      },
      "build:spec": {
        command: "tsx scripts/generate-openapi.ts",
        dependsOn: ["generate:version"],
        // Vite+ task cache is terminal-output-only — a cache hit replays the
        // "Generated openapi.json" stdout but does NOT recreate the file. Since
        // openapi.json is .gitignored and consumed by @libris/docs#build and
        // bruno:import, leaving this cached produces a flaky build whenever
        // the consumer cache-misses while this one cache-hits. The script is
        // ~1s; always running it is the simplest correct option until Vite+
        // ships output-file caching (docs/guide/cache.md §Overview).
        cache: false,
      },
      build: {
        // `&&` splits into independently cached sub-tasks under vp run.
        command: "vp pack && cp -r migrations dist/migrations",
        dependsOn: ["build:spec"],
        // Vite+ task cache is terminal-output-only — a cache hit replays the
        // build stdout but does NOT recreate dist/. CI consumes dist/ via tar
        // immediately after this step, so a cache hit on a fresh runner makes
        // packaging fail with "services/api-hono/dist: Cannot stat". Always
        // re-run the build until Vite+ ships output-file caching
        // (docs/guide/cache.md §Overview, same caveat as build:spec above).
        cache: false,
      },
      check: {
        // GOMEMLIMIT/GOGC cap tsgolint's heap so it can run concurrently with
        // web#type-check (vue-tsc) on CI's 11Gi runners without OOM-killing
        // the latter (exit 137 in run #573 reproduced this when the cap was
        // dropped).
        command: "GOMEMLIMIT=1GiB GOGC=50 vp check",
        dependsOn: ["generate:version"],
        // Don't fingerprint the upstream-generated file itself — its content
        // hash is captured by the dependsOn relationship.
        input: [{ auto: true }, "!src/generated/**"],
      },
      test: {
        command: "vp test run",
        dependsOn: ["generate:version"],
        // Tests touch /tmp/libris-test-* paths configured in test.env above;
        // those are absolute so they're outside auto-tracking, but exclude
        // generated/ for cleanliness.
        //
        // .vite-temp is the important one: loading a TypeScript vite.config
        // makes Vite write a transient `.mjs` into node_modules/.vite-temp/,
        // import it, then delete it. { auto: true } tracks the package dir, so
        // that write lands inside the input set and vp marks the task
        // uncacheable every single run ("read and wrote ...
        // vite.config.ts.timestamp-*.mjs"). This suite is ~5 minutes on a CI
        // runner, so that was the single largest avoidable cost in the
        // pipeline.
        input: [{ auto: true }, "!src/generated/**", "!node_modules/.vite-temp/**"],
      },
      "reset:bullmq": {
        command: "tsx scripts/reset-bullmq.ts",
        cache: false,
      },
      "db:reset": {
        command: "dotenv -e ../../.env -- tsx scripts/db-reset.ts",
        cache: false,
      },
      "db:normalize-languages": {
        command: "dotenv -e ../../.env -- tsx scripts/normalize-languages.ts",
        cache: false,
      },
      "db:studio": {
        command: "dotenv -e ../../.env -- drizzle-kit studio",
        cache: false,
      },
    },
  },
});
