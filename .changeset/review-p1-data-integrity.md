---
"@libris/api-hono": patch
"@libris/web": patch
---

Prevent data loss in the book-organize and cleanup workers, and fix inbox navigation after client-side route changes.

- Organize now gives each book its own id-suffixed library directory and moves files with a no-clobber operation, so two books with the same author/title/filename can no longer overwrite each other; a retry after an interrupted move adopts a destination only when its checksum matches.
- Forced cover re-download no longer deletes the existing cover before the replacement has been fetched.
- Cleanup only deletes a `book_files` row on a confirmed `ENOENT`/`ENOTDIR` and keeps (and reports) records it cannot read.
- The inbox detail page derives its book id reactively, resets per-book state on navigation, and filters server events by the book currently on screen, so rescan/approve/delete reach the right book.
