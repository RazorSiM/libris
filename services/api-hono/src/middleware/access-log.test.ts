import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AppVariables } from "../context.js";
import { accessLogMiddleware } from "./access-log.js";

interface Entry {
  level: "debug" | "info";
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * A logger double that records the level each line was emitted at, not just its
 * metadata — the probe-path behaviour below is entirely about level.
 */
function createRecordingLogger() {
  const entries: Entry[] = [];
  const logger = {
    withMetadata(metadata: Record<string, unknown>) {
      const at = (level: Entry["level"]) => (message: string) => {
        entries.push({ level, message, metadata });
      };
      return { debug: at("debug"), info: at("info") };
    },
  };
  return { entries, logger };
}

interface HarnessOptions {
  /** Status the terminal handler answers with. */
  status?: number;
  /** Middleware that runs between the access log and the handler. */
  before?: Parameters<Hono<{ Variables: AppVariables }>["use"]>[1];
}

function buildApp({ status = 200, before }: HarnessOptions = {}) {
  const { entries, logger } = createRecordingLogger();
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("clientIp", "10.0.0.5");
    c.set("logger", logger as never);
    await next();
  });
  app.use("*", accessLogMiddleware);
  if (before) app.use("*", before);
  app.all("*", (c) => c.text("ok", status as 200));
  return { app, entries };
}

/** The one line an operator greps for: the completed request, with its status. */
function completions(entries: Entry[]) {
  return entries.filter((entry) => entry.message === "request completed");
}

describe("accessLogMiddleware", () => {
  it("logs the resolved client address rather than forwarded headers", async () => {
    const { app, entries } = buildApp();

    await app.request("/", { headers: { "x-forwarded-for": "203.0.113.99" } });

    const metadata = entries.map((entry) => entry.metadata);
    expect(metadata).toHaveLength(2);
    expect(metadata).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          req: expect.objectContaining({ remoteAddress: "10.0.0.5" }),
        }),
      ]),
    );
    expect(JSON.stringify(metadata)).not.toContain("203.0.113.99");
  });

  // ── Probe paths are logged, not skipped ─────────────────────────────

  /**
   * The middleware used to `return next()` for /api/health before touching the
   * logger, so health traffic produced no access-log line of any kind. These
   * three fail against that: the first two find no entry at all, and the third
   * finds no `info` line for the 429 the rate limiter now answers with.
   */
  it("leaves a trace for the readiness check instead of skipping it", async () => {
    const { app, entries } = buildApp();

    await app.request("/api/health");

    expect(completions(entries)).toHaveLength(1);
    expect(completions(entries)[0].metadata).toMatchObject({
      req: { url: "/api/health", method: "GET" },
      res: { statusCode: 200 },
    });
  });

  it("keeps a healthy probe at debug so the steady state stays quiet", async () => {
    const { app, entries } = buildApp();

    await app.request("/api/health");
    await app.request("/api/health/live");

    expect(completions(entries).map((entry) => entry.level)).toEqual(["debug", "debug"]);
  });

  it("raises a rejected health probe to info so a 429 is visible", async () => {
    // What the rate-limit tiering created and the skip hid: /api/health is in
    // the general rate-limit tier now, and a flood that exhausts it answers 429.
    // Under the old middleware that rejection was logged nowhere.
    const limited = vi.fn(async (c: { json: (b: unknown, s: 429) => Response }) =>
      c.json({ error: "Rate limit exceeded" }, 429),
    );
    const { app, entries } = buildApp({ before: limited as never });

    const res = await app.request("/api/health");

    expect(res.status).toBe(429);
    const completed = completions(entries);
    expect(completed).toHaveLength(1);
    expect(completed[0].level).toBe("info");
    expect(completed[0].metadata).toMatchObject({
      req: { url: "/api/health" },
      res: { statusCode: 429 },
    });
  });

  it("raises a degraded readiness response to info", async () => {
    // 503 from the deep check is the other rejection worth seeing.
    const { app, entries } = buildApp({ status: 503 });

    await app.request("/api/health");

    expect(completions(entries)[0].level).toBe("info");
  });

  it("still logs ordinary traffic at info", async () => {
    const { app, entries } = buildApp();

    await app.request("/api/books");

    expect(completions(entries)[0].level).toBe("info");
  });
});
