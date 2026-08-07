---
"@libris/api-hono": patch
---

Rewrite the EPUB OPF and XHTML scanners to run in linear time. The previous
bounded parser (libris-7h7.6) swapped one backtracking regex for another and was
no faster: a 1 KB EPUB carrying a 2 MB OPF of repeated `<dc:title ` tokens blocked
the process for over three minutes, stalling every HTTP request, WebSocket frame
and health check because the ingestion workers run in-process. The same input now
parses in a few milliseconds. Also fixes a case-folding bug in the old scanner
that appended a stray `<` to every Dublin Core field following a character whose
lowercase form is longer than the original (for example `I` with a dot above).
