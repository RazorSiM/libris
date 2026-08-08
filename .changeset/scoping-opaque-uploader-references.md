---
"@libris/api-hono": patch
---

Stop exposing raw user ids as uploader attribution. `uploader.id` on
`GET /api/library`, `/api/library/sync`, `/api/library/{id}`, `/api/inbox` and
`/api/inbox/{id}`, and `uploaders[].id` on `GET /api/library/facets`, are now
opaque per-install references derived from the user id rather than the user id
itself, so the shared catalog can no longer be used to enumerate accounts.

The uploader facet is no longer restricted to the caller's own identity: the
organized library is shared and always showed every uploader's display label on
every book, so restricting only the facet hid nothing while the list, sync and
detail payloads still handed out both the label and the id. Every uploader who
owns an organized book is listed again, and the `uploaderId` filter takes the
opaque reference from the facets response. A value that is not a known reference
(for example a raw user id) now matches no books instead of filtering by it.
