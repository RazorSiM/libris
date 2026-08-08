---
"@libris/api-hono": patch
---

Document `GET /api/events` in the OpenAPI spec.

The WebSocket route was the one endpoint absent from the generated spec: it
cannot use `createRoute` because `upgradeWebSocket` **is** the handler and the
success path never produces a `Response` for a schema to describe. It is now
registered directly on the router's OpenAPI registry, documenting the upgrade
and the four ways it is refused (400 not an upgrade, 401 unauthenticated, 403
cross-site, 429 connection cap), plus the `bookId` filter and the 4401/4409
close codes clients must distinguish.
