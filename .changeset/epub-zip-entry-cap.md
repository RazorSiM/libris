---
"@libris/api-hono": patch
---

Cap the number of records the EPUB ZIP reader will accept from a central
directory, and bound the directory read itself. Every existing budget was
derived from an entry's uncompressed size, so an archive declaring millions of
zero-payload entries passed all of them while still costing ~180 MB of heap and
one file read per entry — enough to OOM a small container during ingestion.
Oversized directories are now rejected at upload time with a 400 instead of
taking down the ingestion worker.
