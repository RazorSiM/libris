---
"@libris/api-hono": patch
---

Bound the endpoints that enqueue metadata and Hardcover work. `POST /api/library/{id}/refetch` and `PATCH /api/inbox/{id}/rescan` now share a deterministic job id (repeat clicks collapse into the in-flight job) and a per-user cap of 10 in-flight metadata jobs, returning 429 beyond it; `POST /api/hardcover/sync` dedups on a per-user job id and answers "Sync already queued" instead of adding another job, and it now uses the registered scheduler queue rather than opening and closing a Redis connection per request (503 if that queue is not running). `GET /api/hardcover/status` caches the live token verification per user for 30 seconds, and connecting or disconnecting a Hardcover credential clears that cache.
