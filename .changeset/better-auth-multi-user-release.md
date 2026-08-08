---
"@libris/api-hono": major
"@libris/web": major
"@libris/docs": major
---

Multi-user authentication, and a security pass over everything it touched.

Libris now has real user accounts. Authentication moves from a single shared API
key to Better Auth: people sign in with an email and password, admins manage
other accounts, and e-readers and scripts authenticate with per-user **app
passwords** instead of one install-wide key. Books, reading progress, inbox
uploads and third-party credentials all belong to a person now, so an install
can be shared without everyone seeing everyone else's things.

## Breaking

Read the **"Upgrading to the Better Auth Release"** runbook in
`docs/deployment.md` before deploying. In short:

- **`BETTER_AUTH_SECRET` is required.** Generate it with `openssl rand -base64
32`. Published placeholders and low-diversity values are rejected at startup,
  so a copied `.env.example` will not boot.
- **`BETTER_AUTH_URL` is required when `NODE_ENV=production`**, and must be the
  public origin the browser actually reaches — scheme and host only, no path.
  Better Auth does not infer an HTTPS origin behind a TLS-terminating proxy; it
  reads the container's plain-HTTP socket, so leaving this unset makes every
  browser sign-in fail with `403 INVALID_ORIGIN`.
- **`COOKIE_DOMAIN` is gone.** The session cookie is host-only, so Libris must be
  served from a single origin. The variable is now ignored rather than rejected,
  so a compose file that still sets it gets no error — delete it.
- **Everyone is signed out** by the upgrade, and **API keys stop working**.
  Re-pair e-readers with app passwords minted under Settings → Connections.
- **KoSync and OPDS credentials must be regenerated.** OPDS now authenticates
  with an account email plus an app password.
- **Rotating `API_SECRET_KEY` now invalidates every KoSync credential**, because
  stored secrets are peppered with a key derived from it. Every paired reader has
  to be paired again after a rotation.
- **Unbanning does not restore app passwords.** Banning disables the user's app
  passwords; lifting the ban leaves them disabled and the user must mint new ones.
- **Upload API:** a file already in the library is reported in a new `skipped[]`
  array rather than `errors[]`, and a batch in which every file was already
  present now answers `200` instead of `400`.
- **OpenAPI:** the `BookApprovedResponse` component is replaced by `BookUpdated`
  (a superset of its fields — no client loses anything).

Upgrading an install that predates this release does **not** need SQL: the
first-run form adopts the existing account, so an operator signs in through it
and sets a password.

## Added

- Sign-in, first-run admin setup, and an Account tab for changing your own name
  and password, listing the devices you are signed in on, and revoking them.
- A Users tab for admins, with the last admin protected from demotion, ban and
  deletion through every path that could otherwise strip them.
- Per-user Hardcover accounts. Previously only one user per install could connect
  one, and a scheduled sync spent whichever token sorted first; the install-wide
  phase now uses an admin's token and skips, loudly, if no admin has connected.
- `GET /api/health/live`, an I/O-free liveness probe for container health checks.
  `GET /api/health` keeps its existing readiness semantics and its response shape.
- The realtime event socket now follows the session: it closes when the session
  behind it is revoked, and re-dials to be re-scoped when your role changes
  rather than signing you out.

## Fixed and hardened

Ownership is now enforced on every read surface — inbox, dashboard counts, search
suggestions, uploader attribution and library facets no longer leak other users'
pre-approval uploads or raw user ids. Rate limiting buckets IPv4 clients
individually, applies a per-credential budget to KoSync and sign-in, and bounds
the request body before it is parsed. EPUB parsing runs in linear time and
refuses archives crafted to exhaust memory. Redis is treated as a cache rather
than the authority on who is signed in, so an outage degrades instead of signing
everyone out. Remote cover fetching, ingestion paths, WebSocket upgrades and
proxy-derived client addresses are all validated at their boundaries.
