---
"@libris/api-hono": patch
"@libris/web": patch
---

Harden rate limiting and the API's error contract.

- Give every IPv4 client its own rate-limit bucket. On a dual-stack listener Node reports IPv4 peers as IPv4-mapped addresses (`::ffff:a.b.c.d`), and those were aggregated into a single `/64` bucket — so one machine could exhaust the general and auth budgets for every IPv4 user at once. Client addresses now resolve to one representation everywhere: rate-limit keys, access logs, the Better Auth client-IP header and trusted-proxy matching.
- Apply the 1 MB request body cap before the rate limiter reads a body. The limiter parses the sign-in body to derive its per-credential bucket and ran first, so an unauthenticated request was buffered whole with no size ceiling in front of it. The limiter now also declines to parse a body over 8 KB and falls back to per-IP limiting.
- Give `POST /kosync/users/auth` the per-credential brute-force budget the GET form already had. It carries the username in its JSON body rather than in `x-auth-user`, so failed attempts only ever counted against the source address — on the endpoint that takes the plaintext KoSync password.
- Rate-limit `/api/health` with the general tier instead of exempting it. The exemption was justified by keeping liveness observable with Redis down, which the general tier's fail-open already provides; unbounded, it was an unauthenticated database round-trip per call on a path access logging also skips.
- Cap app-password labels at 32 characters in the API schema, the OpenAPI description and the settings form alike. The API accepted up to 200 while the underlying plugin rejected anything over 32, so a label typed straight into the form returned `500`.
- Map Better Auth `APIError`s to their own HTTP status app-wide, so no `auth.api.*` rejection can surface as a `500` from any route. Messages on 5xx are logged rather than returned.
- Return the documented validation error shape (`{"error":"Validation failed","issues":[...]}`) from every endpoint. Routers built their own OpenAPI instance at import time and never saw the root app's validation hook, so invalid requests came back as a raw serialized ZodError.
