---
"@libris/api-hono": minor
"@libris/web": minor
---

Report an already-uploaded file as skipped, not as a failed upload.

The upload endpoint refuses to write a file whose exact bytes are already on the
server, because ingestion deduplicates by checksum and would otherwise drop it
silently. That refusal was reported through `errors[]`, alongside "unsupported
format" and "exceeds 100MB" — so a user who dropped four books, one of which was
already in the library, was told one of them had failed. It had not. The library
holds the book, which is the outcome they wanted.

`POST /api/inbox/upload` now answers with three arrays instead of two:

- `uploaded[]` — written to the inbox, queued for the watcher.
- `skipped[]` — `{ filename, reason }`, not written because the content is
  already present. Not a failure.
- `errors[]` — genuine rejections: wrong format, too large, not a readable EPUB,
  unsafe filename.

The status code follows the same split. **A batch where every file was skipped is
now 200, not 400** — nothing about the request was wrong, there was simply
nothing left to do, and calling it a client error told the user off for asking
for something they already had. 400 is now reserved for a batch in which every
file landed in `errors[]`. The reason text is unchanged and still deliberately
uniform ("This file has already been uploaded to this library"): it names neither
the owner of the existing copy nor its status.

The Upload modal reads the new array. A mixed batch reads "3 files uploaded" with
"1 already in your library" beneath it; an all-skipped batch gets a single neutral
"already in your library" notice instead of the error toast it used to raise; real
rejections are now coloured as errors rather than warnings, so the two outcomes no
longer look alike.

API clients that only read `uploaded` and `errors` keep working, but will stop
seeing duplicate rejections — read `skipped` for those.
