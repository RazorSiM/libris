---
"@libris/api-hono": patch
---

Bound inbox uploads before multipart parsing. `POST /api/inbox/upload` now enforces an aggregate byte cap as the body streams — so a chunked request cannot buffer past it — and a file-count cap; both are configurable through `LIBRIS_MAX_UPLOAD_BYTES` (default 1 GiB) and `LIBRIS_MAX_UPLOAD_FILES` (default 20). Previously only `Content-Length`-declared, per-file sizes were checked after the whole request had already been buffered in memory. Also upgrades Hono to 4.13.8, resolving three moderate advisories (including unbounded dot-notation nesting in `parseBody`).
