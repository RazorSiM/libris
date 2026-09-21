---
"@libris/api-hono": patch
---

Take EPUB metadata rewriting off the API event loop. The OPF scans in `embed-metadata` now use the same single-pass XML scanner as the metadata extractor instead of regexes that backtracked quadratically (measured 7.3 s for a 160 KiB crafted OPF), OPF documents over `LIBRIS_MAX_EMBED_OPF_BYTES` (default 1 MiB) are refused before rewriting, and the whole rewrite — including the synchronous DEFLATE recompression — runs in a `node:worker_threads` worker with a hard `LIBRIS_EMBED_TIMEOUT_MS` (default 30 s) timeout. A worker crash or timeout leaves that book un-embedded and the organize job continues instead of stalling every HTTP request.
