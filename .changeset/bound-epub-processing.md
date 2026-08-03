---
"@libris/api-hono": patch
---

Bound EPUB decompression and metadata parsing to prevent compressed files from exhausting memory, disk, or the event loop. Rebuilt EPUBs now retain entry compression instead of persisting inflated archive contents.
