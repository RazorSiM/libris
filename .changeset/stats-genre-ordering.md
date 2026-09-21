---
"@libris/api-hono": patch
---

Rank `GET /api/stats`'s genre distribution by numeric book count. The query ordered by the serialized text alias, so with ten or more genres a count of 9 outranked 10 and the top-ten cutoff could drop a more popular genre; ties now break deterministically by name.
