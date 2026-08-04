import { createMiddleware } from "hono/factory";
import type { AppVariables } from "../context.js";
import { getRequestIp } from "../shared/request-ip.js";

export const clientIpMiddleware = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  c.set("clientIp", getRequestIp(c));
  await next();
});
