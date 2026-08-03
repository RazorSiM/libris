---
"@libris/api-hono": patch
---

Harden ingestion and file serving against untrusted filesystem paths. Queue workers now reject paths outside the inbox, metadata-derived library directories cannot use dot or reserved path components, destination paths are validated before directory creation, and missing served files return 404 instead of 500.
