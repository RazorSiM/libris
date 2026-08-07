---
"@libris/api-hono": patch
---

Apply the 1 MB request body cap before the rate limiter reads a body. The limiter parses the JSON body of the sign-in endpoint to derive its per-credential bucket, and ran first, so an unauthenticated request could be buffered whole with no size ceiling in front of it. The limiter now also refuses to parse a body larger than 8 KB on its own account and falls back to per-IP limiting instead.
