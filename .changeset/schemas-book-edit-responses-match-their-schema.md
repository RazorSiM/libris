---
"@libris/api-hono": patch
---

Book-edit responses now carry only the fields they advertise.

`PATCH /api/library/{id}`, `POST /api/library/{id}/apply-metadata` and
`POST /api/books/{id}/approve` each declare a response schema and then answered
with `db.update(…).returning()` — the argument-less form, which hands back every
column of `books`. That included `search_vector`, the internal full-text index
column: a lexeme dump of the book's title, author, series and description,
returned to the client on every metadata edit and described by nothing in the
OpenAPI document. Editing a book with a long description shipped several
kilobytes of tokenised text nobody could use.

Each of the three now names the columns it returns. The two library routes pass
`bookColumns` — the same list `BookUpdatedSchema` is derived from — so the query
and the schema are two views of one thing and cannot drift apart. `PUT
/kosync/syncs/progress` got the same treatment for a different reason: its bare
`.returning()` was dragging the stored `raw_payload` jsonb back out of the
database on every progress push, for a response that quotes six scalar fields.

No route changes what it returns to a client that was reading the documented
fields.
