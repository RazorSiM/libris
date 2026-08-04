import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../context.js";

export const accessLogMiddleware = createMiddleware<{ Variables: AppVariables }>(
  async (c, next) => {
    if (c.req.path === "/api/health") return next();

    const logger = c.get("logger");
    const request = {
      method: c.req.method,
      url: c.req.path,
      remoteAddress: c.get("clientIp"),
    };
    logger.withMetadata({ req: request }).debug("incoming request");
    const startedAt = Date.now();
    await next();
    logger
      .withMetadata({
        req: request,
        res: { statusCode: c.res.status },
        responseTime: Date.now() - startedAt,
      })
      .info("request completed");
  },
);
