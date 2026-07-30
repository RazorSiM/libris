import { createMiddleware } from "hono/factory";

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();

  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  c.header("permissions-policy", "camera=(), microphone=(), geolocation=()");

  // CSP only for API responses — the SPA and internal routes (/_docs/scalar)
  // need inline scripts that a strict CSP would block.
  if (c.req.path.startsWith("/api/")) {
    c.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  }

  if (c.req.header("x-forwarded-proto") === "https") {
    c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
});
