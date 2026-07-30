import { defineConfig } from "vite-plus";

// `dev`, `build`, and `check` live here (instead of `package.json` scripts)
// so we can declare the cross-package dependency on `@libris/api-hono#build:spec`
// — the docs site imports `@libris/api-hono/openapi.json`, which `build:spec`
// generates. With `dependsOn`, Vite+ orders the graph and feeds the dependency
// into the docs cache fingerprint instead of us shelling out via `pre*` hooks.
export default defineConfig({
  run: {
    tasks: {
      dev: {
        command: "vitepress dev",
        dependsOn: ["@libris/api-hono#build:spec"],
        cache: false,
      },
      build: {
        command: "vitepress build",
        dependsOn: ["@libris/api-hono#build:spec"],
        // vitepress writes the static site to .vitepress/dist/ and a build
        // cache to .vitepress/cache/; exclude both from the input fingerprint
        // (docs/guide/cache.md §Avoiding Overly Broad Input Tracking).
        input: [
          { auto: true },
          "!.vitepress/dist/**",
          "!.vitepress/cache/**",
          "!.vitepress/.temp/**",
          "!node_modules/.vite-temp/**",
        ],
      },
      check: {
        // Check is fmt+lint over the docs source (markdown, .vitepress/*.ts,
        // any .vue components). The full vitepress build already runs in the
        // `build` CI job (and again in `deploy-docs` on main), so duplicating
        // it here was costing ~5min per CI run for no extra validation.
        command: "vp check",
      },
    },
  },
});
