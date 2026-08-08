---
"@libris/api-hono": major
---

Drop `COOKIE_DOMAIN` and make the session cookie host-only.

A `Domain` attribute on a session cookie lets any sibling subdomain set or shadow
it for the app origin, which is session fixation and, at minimum, a denial of
service. Better Auth 1.6.25 emits `__Secure-better-auth.session_token` rather than
`__Host-`, so the strongest fix available today is to drop the
`crossSubDomainCookies` option entirely: with no `Domain`, a subdomain cannot set
the cookie for the app origin at all. Moving to a `__Host-` prefix remains a
documented deferral until Better Auth supports it natively.

Breaking, and **silently** so: `COOKIE_DOMAIN` is no longer read anywhere, and the
env schema ignores unknown variables rather than rejecting them. A deployment that
still sets it gets no error and no warning — the setting is simply ignored. A
multi-subdomain setup that relied on it to share one session across hosts loses
that session with nothing in the logs to explain it. Serve Libris from a single
origin. See "Upgrading to the Better Auth Release" in `docs/deployment.md`.
