import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";

/** Maximum request body size in bytes (1 MB) */
const MAX_BODY_SIZE = 1_048_576;

export const bodyLimitMiddleware = createMiddleware(async (c, next) => {
  // Upload endpoint has its own per-file size validation (100MB)
  if (c.req.path.startsWith("/api/inbox/upload")) return next();
  return bodyLimit({ maxSize: MAX_BODY_SIZE })(c, next);
});
