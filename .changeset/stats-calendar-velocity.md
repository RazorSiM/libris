---
"@libris/api-hono": patch
---

Average reading velocity over calendar days. The 7-day moving average slid over days that had syncs, so a week with reads on only two days divided by two instead of seven and idle days were missing from the series entirely; the window is now filled from a `generate_series` calendar, starting six days before the first day with a read. An install with no reads still reports an empty series rather than 90 zeroes.
