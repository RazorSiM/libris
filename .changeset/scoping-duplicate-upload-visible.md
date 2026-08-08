---
"@libris/api-hono": patch
"@libris/web": patch
---

Tell a user when the file they uploaded is already on the server, instead of
accepting it into a black hole. Ingestion deduplicates by checksum, so a second
upload of bytes that are already in the library produced a 200, a file left in
the inbox directory forever, a permanent `upload_registry` row, and no book the
uploader could see — visible only in a server log line. `POST /api/inbox/upload`
now checks the checksum before writing and rejects the file with a per-file
`errors[]` entry (400 when every file in the batch is rejected). The upload
modal no longer reports "0 files uploaded" as a success.

Two ingestion bugs behind the same symptom are also fixed: the book-detected
worker now attributes a book to the user whose file was actually ingested rather
than to whoever registered first — which decided ownership wrongly whenever two
users uploaded identical bytes concurrently — and it consumes only that user's
registry row instead of deleting every row for the checksum. Any redundant copy
that still reaches the inbox is removed once it is recognised as a duplicate,
and its registry row released; files placed in the inbox by hand are never
deleted.
