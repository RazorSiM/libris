---
"@libris/api-hono": patch
---

Reject cross-site cookie-authenticated mutations.

Centralised CSRF defence in depth. An unsafe method (`POST`, `PUT`, `PATCH`,
`DELETE`) that carries a cookie is now refused with `403` when it arrives with
`Sec-Fetch-Site: cross-site`, or with an `Origin` header naming a host other than
the server's own. The existing controls — `SameSite=Lax` cookies, JSON-only bodies
on most routes, no permissive CORS, no state-changing GETs — already made the
residual risk low; this makes the check explicit and central instead of depending
on all of those being right on every route forever.

Headerless clients are deliberately untouched: an app-password or OPDS request
carries no cookie and no browser `Origin`, so it falls through unaffected. GET
reads are exempt. `/api/auth/*` is not re-checked here, because Better Auth
applies its own origin check to that prefix.

The comparison is against the `Host` header, so a TLS-terminating reverse proxy
does not break it, and the two development origins (`localhost:3100` and
`localhost:3000`) are accepted outside production. Production is same-origin only.
