---
"@libris/api-hono": patch
---

Add `GET /api/health/live`, an I/O-free liveness probe, and stop hiding health traffic from the access log (libris-tnu).

`/api/health` performs a database `SELECT 1` and a Redis `PING` on every unauthenticated call. That is the right cost for the question it answers — "can the API reach its dependencies?" — but the wrong cost for a container probe running on a timer forever, and the wrong signal too: a liveness probe wired to the deep check restarts the container during a database outage, which is the one moment a restart cannot help.

`/api/health/live` answers `200 {"status":"ok","service":"api"}` as soon as the process is serving HTTP and touches nothing else — no database, no Redis, no event bus, and no session lookup (it is policy `public`, not `optional`). Point container liveness probes at it; keep using `/api/health` for readiness, uptime monitoring and incident triage.

**`/api/health` is unchanged** — same response shape, same status codes, same optional-auth enrichment. Nothing that probes it today needs to move.

Health traffic is also no longer skipped by the access-log middleware. Since `/api/health` was moved into the general rate-limit tier, a flood could be answered with `429` and leave no trace anywhere. Successful probes are now logged at `debug` (silent under the default `LOG_LEVEL=info`, so steady-state noise is unchanged) and anything that is not a success — `429`, `503`, `500` — is logged at `info` with its status code.

`docs/deployment.md` gains a Health Endpoints section with Compose and Kubernetes probe recipes.
