---
"@libris/api-hono": patch
"@libris/web": patch
---

Make job browser pagination honest and bounded. `GET /api/jobs` derived `total` and `totalPages` from the first 200 jobs per queue, so a queue with more jobs reported a truncated total and deep pages came back empty with no explanation. `total` now comes from BullMQ's counters (exact); each selected queue/status board is read in its native order up to its share of a 10,000-job window, jobs are attributed to the board they came from (no per-job `getState()` round trip), and the merged window is ordered by creation time with a deterministic queue/id tie-break. Pages past the window are answered from the counters without touching Redis, and the response carries a `truncated` flag — surfaced in the settings browser — when any board holds more matching jobs than the window reaches.
