---
"@libris/api-hono": patch
---

Stop the dashboard reporting other people's pending uploads (libris-44c).

libris-59m.19 scoped `GET /api/dashboard`'s `inboxCount` to the caller, but two
aggregates in the same handler stayed install-wide, and both described exactly
the pre-approval work that count exists to hide.

**`stats.totalFileSize` summed every row in `book_files`**, including files
attached to books still in `inbox` or `review`. The Library Size card therefore
published the byte volume of everyone's unapproved uploads to every signed-in
user — a number that moves the moment someone uploads, so it also leaked the
timing. It now counts organized books' files only, for admins as well.

That is the "shared library" reading rather than the "mine" reading, chosen
because organized books are the shared half of this branch's ownership model
while inbox and review books are per-owner. It also makes the surrounding object
coherent: `totalBooks` and `totalAuthors` beside it have always counted
organized rows, so bytes-per-book now means something, and the number means the
same thing for every caller. The user guide already described the card as "total
disk space used by the organized book files" — the code was the part that
disagreed.

**`pipeline` and `stats.processingCount` were install-wide queue counts.** They
told any user that books they cannot see were being processed, roughly how many,
and how many had failed. BullMQ counts cannot be attributed to an owner, so
`pipeline` is now admin-only and an empty object for everyone else — the
Pipeline Status section on the home page already hides itself when there is no
activity. `processingCount` is instead derived the way `/api/inbox/processing`
already derives its map: from the book ids with a job in flight, intersected
with the caller's own books. Admins keep the install-wide numbers.
