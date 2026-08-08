---
"@libris/api-hono": patch
---

Stop the command palette from suggesting other users' pre-approval uploads.
`GET /api/search/suggest` matched every book in `organized` or `review` status
with no owner filter, so three letters typed into the palette returned the
title, author, cover URL and id of any user's book still awaiting metadata
approval — the exact metadata `/api/inbox` and `/api/inbox/{id}` refuse to show.
Suggest now returns every organized book (the library is shared) plus only the
caller's own review books; admins still see all of them.
