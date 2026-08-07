---
"@libris/api-hono": patch
---

Require `BETTER_AUTH_URL` in production so HTTPS deployments can sign in. Behind a TLS-terminating reverse proxy Better Auth derived the container's plain-http origin, made it the only trusted origin, and refused every browser request with `403 INVALID_ORIGIN`. The server now refuses to boot in production until the public origin is named, validates it is a bare http(s) origin, and pins Better Auth's origin check to `false` so it can no longer switch itself off based on `NODE_ENV`.
