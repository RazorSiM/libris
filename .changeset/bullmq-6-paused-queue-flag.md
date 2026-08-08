---
"@libris/api-hono": minor
"@libris/web": minor
---

Report queue pause state as a flag instead of a job count

BullMQ 6 removed the separate `paused` list that BullMQ 5 parked a paused
queue's jobs in. Pausing now only sets a field on the queue's meta hash and the
jobs stay in `waiting`, so `getJobCounts("paused")` no longer exists.

The settings UI derived "is this queue paused?" from `counts.paused > 0`, which
under BullMQ 6 is permanently false — the PAUSED badge would never appear and
the toggle would only ever pause, never resume. `/api/jobs/status` and
`/api/settings/status` now return a per-queue `isPaused` boolean, read from
`queue.isPaused()`, in place of the `paused` count, and the UI reads that. The
system panel's "Paused" tile now counts paused queues rather than paused jobs.

`paused` is also gone from the `status` filter on `GET /api/jobs`, since there
is no longer a set of jobs in that state to filter for.
