---
"@libris/api-hono": patch
---

Keep reading-statistics baselines when the sample's book was deleted, and stop a zero-delta day from seeding an empty velocity chart. Deleting a book sets its progress-history `book_id` to NULL; an inner join dropped that row, so the first in-period sample was counted from zero a second time (a book at 50% on Dec 31 and 51% on Jan 1 reported 51 pages instead of 1). The baseline queries now left-join the book, and the moving-average bounds only consider days with a positive delta. Adds an index on `(user_id, document, device, created_at DESC)` for the per-stream baseline lookup, which otherwise sorted the user's whole history on every cache miss.
