/**
 * The CI workflow's env blocks, run through the real env validator.
 *
 * libris-59m.3: the e2e job set `E2E_TEST=1` but neither `NODE_ENV` nor
 * `TEST_ROUTE_TOKEN`. `NODE_ENV` has no default in env.ts, so `getEnv()` threw
 * a ZodError before the server bound a port, Playwright's webServer timed out
 * after 60s, and all three shards failed without executing a test. Nothing in
 * the repo could catch that: the only thing that reads those variables is a
 * process CI starts.
 *
 * This closes the loop cheaply — it parses the workflow's own env block with
 * the same schema the server boots with, so a variable that goes missing (or a
 * secret that stops satisfying the validator) fails here instead of in a
 * 60-second webServer timeout.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parseEnv } from "./env.js";

const REPO_ROOT = resolve(import.meta.dirname!, "../../..");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github/workflows/ci.yml");
const COMPOSE_TEST = resolve(REPO_ROOT, "docker-compose.test.yml");

/**
 * Pull one flat `KEY: value` mapping out of a YAML file by locating a key at a
 * known indentation and reading the more-indented lines under it.
 *
 * Hand-rolled rather than pulling in a YAML parser: these blocks are plain
 * scalars with no anchors, quotes optional, and the api-hono package has no
 * YAML dependency to borrow.
 */
function readFlatBlock(file: string, path: string[]): Record<string, string> {
  const lines = readFileSync(file, "utf8").split("\n");
  let depth = 0;
  let index = 0;

  for (const key of path) {
    const wanted = `${" ".repeat(depth * 2)}${key}:`;
    const found = lines.findIndex((line, i) => i >= index && line.startsWith(wanted));
    if (found === -1) throw new Error(`${file}: no "${path.join(".")}" (stuck at "${key}")`);
    index = found + 1;
    depth += 1;
  }

  const indent = " ".repeat(depth * 2);
  const entries: Record<string, string> = {};
  for (let i = index; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (!line.startsWith(indent)) break;
    const body = line.slice(indent.length);
    if (body.startsWith(" ") || body.startsWith("#")) continue;
    const colon = body.indexOf(":");
    if (colon === -1) continue;
    const value = body.slice(colon + 1).trim();
    entries[body.slice(0, colon)] = value.replace(/^["'](.*)["']$/, "$1");
  }
  return entries;
}

describe("E2E harness environments", () => {
  const harnesses: Array<[string, () => Record<string, string>]> = [
    ["ci.yml e2e job", () => readFlatBlock(CI_WORKFLOW, ["jobs", "e2e", "env"])],
    [
      "docker-compose.test.yml playwright service",
      () => readFlatBlock(COMPOSE_TEST, ["services", "playwright", "environment"]),
    ],
  ];

  for (const [label, read] of harnesses) {
    describe(label, () => {
      it("parses with the schema the server boots with", () => {
        // The assertion that fails on the old workflow: without NODE_ENV this
        // throws `NODE_ENV: Invalid option`, which is verbatim what killed the
        // e2e job.
        expect(() => parseEnv({ ...read(), PORT: "3000" })).not.toThrow();
      });

      it("can authenticate the /__test/* support routes", () => {
        // middleware/auth.ts compares against a >=32-byte token and 401s
        // otherwise, so a short or absent value degrades into every support
        // route silently refusing rather than a startup error.
        const env = parseEnv({ ...read(), PORT: "3000" });
        expect(env.E2E_TEST).toBe("1");
        expect(Buffer.byteLength(env.TEST_ROUTE_TOKEN ?? "")).toBeGreaterThanOrEqual(32);
      });

      it("never pairs E2E_TEST=1 with NODE_ENV=production", () => {
        // bootstrap.ts throws on that combination.
        const env = parseEnv({ ...read(), PORT: "3000" });
        expect(env.NODE_ENV).not.toBe("production");
      });
    });
  }

  describe("ci.yml e2e-prod-config job", () => {
    const read = () => readFlatBlock(CI_WORKFLOW, ["jobs", "e2e-prod-config", "env"]);

    it("parses with the schema the server boots with", () => {
      expect(() => parseEnv({ ...read(), PORT: "3000" })).not.toThrow();
    });

    it("actually runs the production branch, with no test switches on", () => {
      // The job's entire reason to exist. bootstrap.ts throws on
      // E2E_TEST=1 + production, and a TEST_ROUTE_TOKEN here would mount
      // support routes the production build must not have.
      const env = parseEnv({ ...read(), PORT: "3000" });
      expect(env.NODE_ENV).toBe("production");
      expect(env.E2E_TEST).not.toBe("1");
      expect(env.TEST_ROUTE_TOKEN).toBeUndefined();
    });

    it("leaves BETTER_AUTH_URL unset", () => {
      // Setting it would hand Better Auth the trusted origin it is supposed to
      // derive from the request, which is the exact branch this job exists to
      // exercise.
      expect(parseEnv({ ...read(), PORT: "3000" }).BETTER_AUTH_URL).toBe("");
    });
  });

  it("keeps the two harnesses on the same NODE_ENV", () => {
    // Divergence here means CI and local Docker take different branches in
    // lib/auth.ts, bootstrap.ts and lib/logger.ts, which is how a config bug
    // survives a green local run.
    const ci = readFlatBlock(CI_WORKFLOW, ["jobs", "e2e", "env"]);
    const compose = readFlatBlock(COMPOSE_TEST, ["services", "playwright", "environment"]);
    expect(ci.NODE_ENV).toBe(compose.NODE_ENV);
  });
});
