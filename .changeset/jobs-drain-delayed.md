---
"@libris/api-hono": patch
---

Drain delayed jobs from a queue. `POST /api/jobs/queues/{name}/drain` documented removing waiting and delayed jobs, but called BullMQ's `drain()` without `true`, leaving scheduled jobs behind.
