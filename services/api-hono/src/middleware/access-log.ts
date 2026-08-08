import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../context.js";

/**
 * Probe paths: polled on a timer by orchestrators and uptime monitors, forever.
 *
 * These used to be skipped by the middleware outright, which was defensible
 * when nothing could reject them. It stopped being defensible once
 * libris-59m.38 put `/api/health` in the general rate-limit tier: a 429 on the
 * endpoint an operator uses to decide whether the service is alive left no
 * trace at all, so a health check that had started failing looked identical in
 * the logs to one that was never called (libris-tnu).
 *
 * So they are logged like everything else, just quietly: a successful probe
 * lands at `debug` (off under the default `LOG_LEVEL=info`, so the steady-state
 * noise is unchanged), and anything that is not a success — a 429, a 503 from
 * the readiness check, a 500 — is logged at the normal `info` level where an
 * operator will actually see it.
 */
const PROBE_PATHS = new Set(["/api/health", "/api/health/live"]);

export const accessLogMiddleware = createMiddleware<{ Variables: AppVariables }>(
  async (c, next) => {
    const logger = c.get("logger");
    const request = {
      method: c.req.method,
      url: c.req.path,
      remoteAddress: c.get("clientIp"),
    };
    logger.withMetadata({ req: request }).debug("incoming request");
    const startedAt = Date.now();
    await next();
    const completed = logger.withMetadata({
      req: request,
      res: { statusCode: c.res.status },
      responseTime: Date.now() - startedAt,
    });
    if (PROBE_PATHS.has(c.req.path) && c.res.status < 400) {
      completed.debug("request completed");
      return;
    }
    completed.info("request completed");
  },
);
