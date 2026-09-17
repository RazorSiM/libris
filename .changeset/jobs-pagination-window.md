---
"@libris/api-hono": patch
"@libris/web": patch
---

Make job browser pagination honest. `GET /api/jobs` derived `total` and `totalPages` from the first 200 jobs per queue, so a queue with more jobs reported a truncated total and deep pages came back empty with no explanation. `total` now comes from BullMQ's counters (exact), the newest 10,000 jobs are materialized for the requested page, and the response carries a `truncated` flag — surfaced in the settings browser — when older jobs fall outside that window.
