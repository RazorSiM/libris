import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    arrowParens: "always",
    endOfLine: "lf",
    sortPackageJson: true,
    // Skip auto-generated changesets and bd-tool data — they're regenerated
    // and the formatter shouldn't touch them. Also skip vitepress build
    // artifacts: oxfmt traverses the generated HTML/JS in .vitepress/dist/
    // and crashes with "failed printing to stdout: Resource temporarily
    // unavailable". Per-package `fmt:` overrides don't take effect, so the
    // ignore has to live here at the workspace root.
    ignorePatterns: [
      "**/CHANGELOG.md",
      // Auto-generated from the Drizzle schema by docs/scripts/generate-docs.ts;
      // the generator owns its formatting, so the formatter must not touch it.
      "docs/database.md",
      ".beads/**",
      "**/.vitepress/dist/**",
      "**/.vitepress/cache/**",
      "**/.vitepress/.temp/**",
    ],
  },
  lint: {
    categories: {
      correctness: "error",
    },
    plugins: ["eslint", "oxc", "typescript", "unicorn", "vue"],
    rules: {
      "vue/valid-define-props": "error",
      "vue/valid-define-emits": "error",
      "vue/no-export-in-script-setup": "error",
      "vue/no-lifecycle-after-await": "error",
      "vue/no-arrow-functions-in-watch": "error",
      "vue/no-this-in-before-route-enter": "error",
      "vue/no-deprecated-destroyed-lifecycle": "error",
      "vue/prefer-import-from-vue": "error",
      "vue/no-import-compiler-macros": "error",
      "vue/no-multiple-slot-args": "error",
      "vue/no-required-prop-with-default": "error",
      "vue/require-default-export": "error",
      "vue/define-emits-declaration": "error",
      "vue/define-props-declaration": "error",
      "vue/define-props-destructuring": "error",
      "vue/require-typed-ref": "error",
      "vue/max-props": [
        "warn",
        {
          maxProps: 15,
        },
      ],
    },
    env: {
      browser: true,
      node: true,
      es2024: true,
    },
    ignorePatterns: [
      "dist/",
      "*.min.js",
      // VitePress runtime glue (config.ts, theme/, openapi.ts) imports
      // modules — `vue`, `@libris/api-hono/openapi.json` — that tsgolint
      // can't resolve outside the bundler. The full vitepress build (which
      // DOES resolve these) still runs in the build CI job. Pattern is
      // unscoped because oxlint resolves it relative to its working
      // directory; per-package `lint:` overrides don't take effect.
      "**/.vitepress/**",
      // Docs build scripts run via `node --experimental-strip-types` and
      // aren't part of any tsconfig include — tsgolint can't resolve their
      // node:* imports. They have no runtime cross-package surface to lint.
      "**/docs/scripts/**",
    ],
    // `vp create`/`vp migrate` enable both by default; we match that. `typeAware`
    // unlocks typescript-eslint rules that need type info (no-floating-promises
    // etc.). `typeCheck` runs tsgolint's TS-error pass alongside lint — types
    // that need to cross the .vue/.ts boundary must live in .ts files (tsgolint
    // can't read .vue script blocks), see MetadataFieldPicker.types.ts.
    options: {
      typeAware: true,
      typeCheck: true,
    },
    overrides: [
      {
        // Vitest matcher chains (`expect(spy).toHaveBeenCalled()`) read the
        // method off the mock without calling it, which fires unbound-method
        // on every assertion. The mock is intentionally unbound — disabling
        // the rule for test files is the standard workaround.
        files: ["**/*.test.ts", "**/*.spec.ts"],
        rules: {
          "typescript/unbound-method": "off",
        },
      },
    ],
  },

  // Staged-file checks for `vp staged` (invoked by lefthook's pre-commit hook).
  // Mirrors the previous lefthook glob-to-command map: code files get linted +
  // formatted, content files get formatted only.
  staged: {
    "*.{ts,tsx,mts,js,jsx,mjs}": ["vp lint --fix", "vp fmt"],
    "*.{json,md,html,css,vue}": "vp fmt",
  },

  // Workspace-level tasks. Per-package aliases (`dev:server`, `test:api`, …)
  // were dropped — invoke per-package work via `vp run -F @libris/<pkg> <task>`
  // directly. The aggregators below are kept because they're the canonical
  // CI/validation invocations and benefit from execution-summary output.
  // Vite Task auto-prunes the self-reference when `vp run -r build` resolves
  // to this `build` task again (see docs/guide/run.md §Compound Commands).
  run: {
    tasks: {
      build: { command: "vp run -r build" },
      test: { command: "vp run -r test" },
      check: { command: "vp run -r check" },
      "bruno:import": { command: "./scripts/bruno-import.sh", cache: false },
      "test:e2e:docker": { command: "./scripts/test-e2e.sh", cache: false },
    },
  },
});
