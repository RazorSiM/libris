# Environment Variables

## API Service (Hono)

| Variable                         | Required    | Default        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                       | **Yes**     | —              | `development`, `production`, or `test`. Must be explicit so omitted configuration cannot disable production safeguards.                                                                                                                                                                                                                                                                                                                                                                       |
| `POSTGRES_HOST`                  | Yes         | —              | Postgres host. Combined with the vars below into the connection URL by `src/lib/resolve-database-url.ts`.                                                                                                                                                                                                                                                                                                                                                                                     |
| `POSTGRES_PORT`                  | No          | `5432`         | Postgres port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POSTGRES_USER`                  | Yes         | —              | Postgres user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `POSTGRES_PASSWORD`              | Yes         | —              | Postgres password.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POSTGRES_DB`                    | Yes         | —              | Postgres database name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `REDIS_HOST`                     | Yes         | —              | Redis host. Combined with the vars below into the connection URL by `src/lib/resolve-redis-url.ts`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `REDIS_PORT`                     | No          | `6379`         | Redis port.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `REDIS_USER`                     | No          | —              | Redis ACL user (leave unset unless your deployment uses ACLs).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `REDIS_PASSWORD`                 | No          | —              | Redis password.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `REDIS_TLS`                      | No          | —              | Set to `1` or `true` to use `rediss://` (TLS). Required for most managed Redis providers.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LIBRIS_INBOX_PATH`              | Yes         | —              | Directory watched for new book files                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `LIBRIS_LIBRARY_PATH`            | Yes         | —              | Directory for organized book storage                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `LIBRIS_COVER_FETCH_ALLOWLIST`   | No          | —              | Comma-separated exact HTTP(S) origins permitted to serve covers from private or special-use networks, for example `http://covers.lan:8080`. Scheme, hostname, and port must match; paths are rejected. Redirect targets are checked independently.                                                                                                                                                                                                                                            |
| `API_SECRET_KEY`                 | Yes         | —              | Secret for third-party token encryption. Generate with `openssl rand -hex 32`; published placeholders and low-diversity values are rejected at startup.                                                                                                                                                                                                                                                                                                                                       |
| `BETTER_AUTH_SECRET`             | Yes         | —              | Signs Better Auth session cookies (min 32 chars). Generate with `openssl rand -base64 32`; published placeholders and low-diversity values are rejected at startup. Deliberately separate from `API_SECRET_KEY` with no fallback — the server refuses to start without it, and changing it signs out every user.                                                                                                                                                                              |
| `BETTER_AUTH_URL`                | Conditional | —              | **Required when `NODE_ENV=production`** — the server refuses to boot without it. Public origin of the app (e.g. `https://libris.example.com`): scheme and host only, no path, query or credentials. Better Auth does _not_ infer an https origin behind a TLS-terminating proxy — it reads the container's plain-http socket address, so leaving this unset makes every browser sign-in fail with `403 INVALID_ORIGIN`. Optional in development, where the request origin is already correct. |
| `PORT`                           | No          | `3000`         | Port the API server listens on                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LIBRIS_COOKIE_SECURE`           | No          | `1`            | Set to `0` only for a plain-HTTP deployment. This controls the auth cookie's `Secure` attribute independently of `NODE_ENV`; disabling it weakens transport protection.                                                                                                                                                                                                                                                                                                                       |
| `MIGRATIONS_PATH`                | No          | `./migrations` | Path to database migration files. Used by `runMigrations()` in `bootstrap.ts` to auto-apply migrations on startup.                                                                                                                                                                                                                                                                                                                                                                            |
| `TRUST_PROXY_HEADERS`            | No          | `0`            | Set to `1` to accept forwarded client-IP headers only when the immediate TCP peer matches `LIBRIS_TRUSTED_PROXIES`.                                                                                                                                                                                                                                                                                                                                                                           |
| `LIBRIS_TRUSTED_PROXIES`         | Conditional | —              | Comma-separated exact proxy IPs or narrow CIDRs, required when `TRUST_PROXY_HEADERS=1`. Forwarded chains are walked right-to-left; client-controlled entries before the first untrusted hop are ignored.                                                                                                                                                                                                                                                                                      |
| `LOG_LEVEL`                      | No          | `info`         | Minimum log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Gates the Pino transport, which is what production and both E2E harnesses use. An interactive `NODE_ENV=development` terminal gets the pretty-terminal transport instead; `E2E_TEST=1` opts back out of it so CI logs stay machine-readable. Only `NODE_ENV=test` disables logging.                                                                                                                                    |
| `TEST_ROUTE_TOKEN`               | No          | —              | Required at 32+ characters to use test-support routes when `NODE_ENV=test` or `E2E_TEST=1`. Sent as `X-Test-Token` to authenticate `__test/`; without it every request is refused. Never set in production.                                                                                                                                                                                                                                                                                   |
| `LIBRIS_HTTP_HEADERS_TIMEOUT_MS` | No          | `10000`        | Maximum time to receive complete HTTP headers.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `LIBRIS_HTTP_REQUEST_TIMEOUT_MS` | No          | `30000`        | Maximum time to receive an entire HTTP request, including its body.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LIBRIS_HTTP_IDLE_TIMEOUT_MS`    | No          | `30000`        | Maximum inactivity period for an HTTP connection.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### Rate Limiting

Defaults are tuned for LAN/VPN deployments — generous enough that normal use (OPDS browsing, API-key management, the frontend's polling) never trips them. If exposing Libris publicly, lower these to something like `100`/`10`/`5` for general/auth/key-creation. See [Architecture › Rate Limiting](./architecture.md#rate-limiting) for the per-endpoint tier mapping.

| Variable                                       | Required | Default | Purpose                                                                               |
| ---------------------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| `LIBRIS_RATELIMIT_GENERAL_LIMIT`               | No       | `600`   | Max requests per window for general API/OPDS/kosync traffic.                          |
| `LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS`      | No       | `60`    | Window size in seconds for the `general` tier.                                        |
| `LIBRIS_RATELIMIT_AUTH_LIMIT`                  | No       | `30`    | Max credential-input requests per window (`/kosync/users/auth`, credential creation). |
| `LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS`         | No       | `60`    | Window size in seconds for the `auth` tier.                                           |
| `LIBRIS_RATELIMIT_KEY_CREATION_LIMIT`          | No       | `30`    | Max credential-creation requests per window (stacks with `auth`).                     |
| `LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS` | No       | `3600`  | Window size in seconds for the `keyCreation` tier.                                    |

### `/api/auth/*` is limited by Better Auth, not by these

None of the variables above apply to Better Auth's own endpoints — sign-in,
sign-out, password and email changes, the admin plugin, and API-key management.
Better Auth rate-limits that prefix itself, with much tighter per-endpoint
windows than a shared tier can express (three requests per ten seconds on
sign-in and password change). The app's limiter stands aside for the whole
prefix so the two budgets cannot stack and produce a 429 that neither one
explains.

Those counters live in the same Redis as sessions, so they survive a restart.
There is nothing to configure — to change them, edit `rateLimit` in
`services/api-hono/src/lib/auth.ts`.

What the app's own tiers still cover:

| Tier          | Applies to                                                                                |
| ------------- | ----------------------------------------------------------------------------------------- |
| `auth`        | `/kosync/users/auth` — KOReader speaks its own protocol, outside Better Auth's reach      |
| `keyCreation` | `POST /api/setup` and `POST /api/app-passwords` — each costs a password hash              |
| `general`     | every path except Better Auth's separately limited `/api/auth/*` — `/api/health` included |

`DATABASE_URL` is still read as an escape hatch. When set, `src/lib/resolve-database-url.ts` returns it verbatim and it takes precedence over the split `POSTGRES_*` vars. When unset, the app assembles the connection URL from the split vars above. This gives docker-compose and the app a single source of truth in dev (compose interpolates the same `POSTGRES_*` values; see `docker-compose.dev.yml` for the `${POSTGRES_USER:-libris}` interpolation), while CI and tests can override with a single `DATABASE_URL`.

`REDIS_URL` is no longer read — the Redis connection is always assembled from the `REDIS_*` split vars by `src/lib/resolve-redis-url.ts`.

The rate-limit cache uses an in-memory KV store in development (no Redis connection needed for rate limiting), but limits remain enabled. BullMQ and the ingestion workers still require Redis in development — only `NODE_ENV=test` stubs out the queues. Run a Redis instance locally (or via `docker-compose.dev.yml`) when developing.

## OpenTelemetry

Libris supports exporting logs and traces via [OpenTelemetry](https://opentelemetry.io/). The OTel SDK activates when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. All configuration uses standard OTel environment variables — no custom Libris-specific vars are needed.

| Variable                      | Required | Default         | Purpose                                                       |
| ----------------------------- | -------- | --------------- | ------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No       | —               | OTLP collector URL (e.g., `http://alloy:4318`). Enables OTel. |
| `OTEL_SERVICE_NAME`           | No       | `libris`        | Service name in telemetry data                                |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | No       | `http/protobuf` | Protocol: `http/protobuf`, `http/json`, or `grpc`             |
| `OTEL_TRACES_EXPORTER`        | No       | `otlp`          | Trace exporter. Set to `none` to disable traces.              |
| `OTEL_LOGS_EXPORTER`          | No       | `otlp`          | Log exporter. Set to `none` to disable log export.            |
| `OTEL_METRICS_EXPORTER`       | No       | `otlp`          | Metrics exporter. Set to `none` to disable metrics.           |

When `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, the OTel SDK does not initialize and adds zero overhead. Logs still flow to stdout via Pino regardless of OTel configuration.

## Frontend (Vue SPA)

In production, the SPA is served by the Hono backend from the same origin — no frontend-specific configuration is needed. API requests use relative URLs (`/api/*`).

In development, the Vite dev server runs on port 3100 and proxies `/api/*` requests to the backend on port 3000 via its built-in proxy.

### Frontend configuration

The SPA reads two configuration values: `wsBaseUrl` (base URL for the realtime WebSocket) and `docsUrl` (link to the documentation site, surfaced as a sidebar nav item when set). They resolve in two stages in `apps/web/src/main.ts`:

1. **Build-time defaults** from `VITE_*` env vars baked into the bundle.
2. **Runtime overrides** from a `/config.json` file fetched at startup. Any keys it returns override the build-time defaults, so a single static asset can reconfigure an already-built image.

| Variable           | Stage      | Default                       | Purpose                                                                                             |
| ------------------ | ---------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `VITE_WS_BASE_URL` | Build-time | `""` (same-origin WebSocket)  | Base URL for the realtime WebSocket at `/api/events`. Empty means derive it from `window.location`. |
| `VITE_DOCS_URL`    | Build-time | `https://docs.libris.raz.wtf` | Documentation site URL shown in the sidebar.                                                        |

At runtime, an optional `/config.json` served alongside the SPA can override either value:

```json
{ "wsBaseUrl": "wss://books.example.com", "docsUrl": "https://docs.example.com" }
```

If `/config.json` is absent or unreadable, the build-time defaults apply.

## Metadata Sources

The Hardcover API token for metadata enrichment is stored in the database via Settings > Connections, not as an env var. It is optional — if not configured, external metadata enrichment is skipped during ingestion.

| Source    | Key type     | Where to get it                                                |
| --------- | ------------ | -------------------------------------------------------------- |
| Hardcover | Bearer token | [hardcover.app/account/api](https://hardcover.app/account/api) |

## Test Environment

| Variable               | Value                     | Purpose                                                                                                                                                                                                                      |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`             | `development`             | Explicitly selects source-server behavior. Test support still requires `E2E_TEST=1`; development alone does not mount `__test/` routes.                                                                                      |
| `LIBRIS_COOKIE_SECURE` | `0`                       | Allows the browser test suite to use auth cookies over its local HTTP origin.                                                                                                                                                |
| `POSTGRES_HOST`        | `localhost`               | Isolated test DB                                                                                                                                                                                                             |
| `POSTGRES_PORT`        | `5433`                    | Test Postgres port (non-standard to avoid clashing with dev)                                                                                                                                                                 |
| `POSTGRES_USER`        | `libris_test`             |                                                                                                                                                                                                                              |
| `POSTGRES_PASSWORD`    | `libris_test`             |                                                                                                                                                                                                                              |
| `POSTGRES_DB`          | `libris_test`             |                                                                                                                                                                                                                              |
| `REDIS_HOST`           | `localhost`               | Isolated test Redis                                                                                                                                                                                                          |
| `REDIS_PORT`           | `6380`                    | Test Redis port (non-standard)                                                                                                                                                                                               |
| `LIBRIS_INBOX_PATH`    | `/tmp/libris-e2e/inbox`   | Ephemeral inbox                                                                                                                                                                                                              |
| `LIBRIS_LIBRARY_PATH`  | `/tmp/libris-e2e/library` | Ephemeral library                                                                                                                                                                                                            |
| `E2E_TEST`             | `1`                       | Enables authenticated `__test/` support routes and relaxes rate limits. Cannot be used with `NODE_ENV=production`.                                                                                                           |
| `TEST_ROUTE_TOKEN`     | test-only secret          | Dedicated secret sent as `X-Test-Token` for every `__test/` request. Must be at least 32 characters.                                                                                                                         |
| `API_SECRET_KEY`       | throwaway 32-byte hex     | Still validated in test: placeholders and low-diversity strings are rejected at startup, so it cannot be a filler value.                                                                                                     |
| `BETTER_AUTH_SECRET`   | throwaway 32-byte hex     | Same validation. The API refuses to boot without it, so the E2E stack does not start if it is missing from `.env.test`.                                                                                                      |
| `E2E_ADMIN_USER_ID`    | (auto-generated)          | Set by `global-setup.ts`, not user-provided. The admin's `users.id`, used for seeding `books.created_by` and per-user rows.                                                                                                  |
| `E2E_REGULAR_USER_ID`  | (auto-generated)          | The non-admin user's `users.id`.                                                                                                                                                                                             |
| `E2E_API_KEY`          | (auto-generated)          | The admin's **app password**, minted via `POST /api/app-passwords` after `global-setup.ts` bootstraps the account through `POST /api/setup`.                                                                                 |
| `E2E_USER_API_KEY`     | (auto-generated)          | The non-admin user's app password, for the multi-user tests.                                                                                                                                                                 |
| `E2E_ADMIN_COOKIE`     | (auto-generated)          | The admin's replayable session cookie. Needed because app passwords are refused on admin routes, `/api/auth/*`, `/api/app-passwords` and `/api/credentials` — a spec driving those must authenticate the way a browser does. |
| `E2E_USER_COOKIE`      | (auto-generated)          | The non-admin user's session cookie, for the same reason.                                                                                                                                                                    |

Rate limiting is disabled only when the explicit `E2E_TEST=1` switch is set (see `src/middleware/rate-limit.ts`), so `NODE_ENV` does not silently alter request protection. Ordinary development remains limited using the in-memory store.

Every `__test/` request must carry the dedicated `X-Test-Token`. Outside
`NODE_ENV=test` or `E2E_TEST=1`, the router is not registered and these paths
return 404 regardless of the token.

The paths and ports above mirror `.env.test.example` (the dev-server mode template); the Docker mode (`./scripts/test-e2e.sh`) sets its own env vars and ignores that file. See `.env.test.example` for the complete template.
