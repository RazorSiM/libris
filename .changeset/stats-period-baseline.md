---
"@libris/api-hono": patch
---

Fix stats period boundaries double-counting progress. Page deltas for the heatmap and reading velocity were computed after filtering history to the display period, so the first sync of a period had no previous sample and its whole percentage counted as pages read (a 100-page book at 50% on Dec 31 and 51% on Jan 1 reported 51 pages instead of 1). Each `(document, device)` stream now carries its last pre-period sample as the LAG baseline, with only in-period rows aggregated.
