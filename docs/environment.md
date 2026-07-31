# Environment Variables

## API Service (Hono)

| Variable              | Required | Default        | Purpose                                                                                                                                                                                                                                                   |
| --------------------- | -------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`            | No       | `development`  | `development`, `production`, or `test`.                                                                                                                                                                                                                   |
| `POSTGRES_HOST`       | Yes      | —              | Postgres host. Combined with the vars below into the connection URL by `src/lib/resolve-database-url.ts`.                                                                                                                                                 |
| `POSTGRES_PORT`       | No       | `5432`         | Postgres port.                                                                                                                                                                                                                                            |
| `POSTGRES_USER`       | Yes      | —              | Postgres user.                                                                                                                                                                                                                                            |
| `POSTGRES_PASSWORD`   | Yes      | —              | Postgres password.                                                                                                                                                                                                                                        |
| `POSTGRES_DB`         | Yes      | —              | Postgres database name.                                                                                                                                                                                                                                   |
| `REDIS_HOST`          | Yes      | —              | Redis host. Combined with the vars below into the connection URL by `src/lib/resolve-redis-url.ts`.                                                                                                                                                       |
| `REDIS_PORT`          | No       | `6379`         | Redis port.                                                                                                                                                                                                                                               |
| `REDIS_USER`          | No       | —              | Redis ACL user (leave unset unless your deployment uses ACLs).                                                                                                                                                                                            |
| `REDIS_PASSWORD`      | No       | —              | Redis password.                                                                                                                                                                                                                                           |
| `REDIS_TLS`           | No       | —              | Set to `1` or `true` to use `rediss://` (TLS). Required for most managed Redis providers.                                                                                                                                                                 |
| `LIBRIS_INBOX_PATH`   | Yes      | —              | Directory watched for new book files                                                                                                                                                                                                                      |
| `LIBRIS_LIBRARY_PATH` | Yes      | —              | Directory for organized book storage                                                                                                                                                                                                                      |
| `API_SECRET_KEY`      | Yes      | —              | Secret for token encryption (min 32 chars)                                                                                                                                                                                                                |
| `BETTER_AUTH_SECRET`  | Yes      | —              | Signs Better Auth session cookies (min 32 chars). Generate with `openssl rand -base64 32`. Deliberately separate from `API_SECRET_KEY` with no fallback — the server refuses to start without it, and changing it signs out every user.                   |
| `BETTER_AUTH_URL`     | No       | —              | Public origin of the app (e.g. `https://libris.example.com`). Leave unset to let Better Auth infer the origin per request, which is correct when a reverse proxy terminates TLS in front of the container. Set it only if that inference is wrong.        |
| `PORT`                | No       | `3000`         | Port the API server listens on                                                                                                                                                                                                                            |
| `COOKIE_DOMAIN`       | No       | —              | Parent domain for auth cookie (e.g., `.example.com`). Leave empty when on a single domain.                                                                                                                                                                |
| `MIGRATIONS_PATH`     | No       | `./migrations` | Path to database migration files. Used by `runMigrations()` in `bootstrap.ts` to auto-apply migrations on startup.                                                                                                                                        |
| `TRUST_PROXY_HEADERS` | No       | `0`            | Set to `1` only when all requests pass through a trusted reverse proxy and its client IP headers should drive auth logging and rate limiting.                                                                                                             |
| `LOG_LEVEL`           | No       | `info`         | Minimum log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Gates the production Pino transport only. The development pretty-terminal transport does not read it, and the OpenTelemetry transport is always attached regardless of this value. |

### Rate Limiting

Defaults are tuned for LAN/VPN deployments — generous enough that normal use (OPDS browsing, API-key management, the frontend's polling) never trips them. If exposing Libris publicly, lower these to something like `100`/`10`/`5` for general/auth/key-creation. See [Architecture › Rate Limiting](./architecture.md#rate-limiting) for the per-endpoint tier mapping.

| Variable                                       | Required | Default | Purpose                                                                             |
| ---------------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------- |
| `LIBRIS_RATELIMIT_GENERAL_LIMIT`               | No       | `600`   | Max requests per window for general API/OPDS/kosync traffic.                        |
| `LIBRIS_RATELIMIT_GENERAL_WINDOW_SECONDS`      | No       | `60`    | Window size in seconds for the `general` tier.                                      |
| `LIBRIS_RATELIMIT_AUTH_LIMIT`                  | No       | `30`    | Max credential-input requests per window (login, setup, key creation, kosync auth). |
| `LIBRIS_RATELIMIT_AUTH_WINDOW_SECONDS`         | No       | `60`    | Window size in seconds for the `auth` tier.                                         |
| `LIBRIS_RATELIMIT_KEY_CREATION_LIMIT`          | No       | `30`    | Max API-key-creation requests per window (stacks with `auth`).                      |
| `LIBRIS_RATELIMIT_KEY_CREATION_WINDOW_SECONDS` | No       | `3600`  | Window size in seconds for the `keyCreation` tier.                                  |

`DATABASE_URL` is still read as an escape hatch. When set, `src/lib/resolve-database-url.ts` returns it verbatim and it takes precedence over the split `POSTGRES_*` vars. When unset, the app assembles the connection URL from the split vars above. This gives docker-compose and the app a single source of truth in dev (compose interpolates the same `POSTGRES_*` values; see `docker-compose.dev.yml` for the `${POSTGRES_USER:-libris}` interpolation), while CI and tests can override with a single `DATABASE_URL`.

`REDIS_URL` is no longer read — the Redis connection is always assembled from the `REDIS_*` split vars by `src/lib/resolve-redis-url.ts`.

The rate-limit cache uses an in-memory KV store in development (no Redis connection needed for rate limiting). BullMQ and the ingestion workers still require Redis in development — only `NODE_ENV=test` stubs out the queues. Run a Redis instance locally (or via `docker-compose.dev.yml`) when developing.

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

| Variable              | Value                     | Purpose                                                                                                                                            |
| --------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_HOST`       | `localhost`               | Isolated test DB                                                                                                                                   |
| `POSTGRES_PORT`       | `5433`                    | Test Postgres port (non-standard to avoid clashing with dev)                                                                                       |
| `POSTGRES_USER`       | `libris_test`             |                                                                                                                                                    |
| `POSTGRES_PASSWORD`   | `libris_test`             |                                                                                                                                                    |
| `POSTGRES_DB`         | `libris_test`             |                                                                                                                                                    |
| `REDIS_HOST`          | `localhost`               | Isolated test Redis                                                                                                                                |
| `REDIS_PORT`          | `6380`                    | Test Redis port (non-standard)                                                                                                                     |
| `LIBRIS_INBOX_PATH`   | `/tmp/libris-e2e/inbox`   | Ephemeral inbox                                                                                                                                    |
| `LIBRIS_LIBRARY_PATH` | `/tmp/libris-e2e/library` | Ephemeral library                                                                                                                                  |
| `E2E_TEST`            | `1`                       | Set to `"1"` to enable. Allows `__test/` routes and relaxes auth checks. Cannot be used with `NODE_ENV=production`.                                |
| `E2E_API_KEY`         | (auto-generated)          | Auto-generated by `global-setup.ts` (not user-provided). Seeds an admin API key via `/api/auth/setup` before tests run.                            |
| `E2E_USER_API_KEY`    | (auto-generated)          | Auto-generated by `global-setup.ts`. Seeds a second, non-admin key (via `/api/auth/keys`, with a direct-DB fallback) used by the multi-user tests. |

Rate limiting is disabled whenever `NODE_ENV` is `development` or `test`, or `E2E_TEST=1` (see `src/middleware/rate-limit.ts`), so the test environment never trips limits.

The paths and ports above mirror `.env.test.example` (the dev-server mode template); the Docker mode (`./scripts/test-e2e.sh`) sets its own env vars and ignores that file. See `.env.test.example` for the complete template.
