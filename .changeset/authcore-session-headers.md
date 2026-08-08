---
"@libris/api-hono": patch
---

Stop a client-supplied `x-libris-client-ip` header reaching Better Auth on
`POST /api/auth/admin/remove-user`.

Better Auth is configured to read the caller's address from one private header,
on the promise that the app always overwrites it with the address resolved from
the TCP connection. The book-reassignment middleware on the remove-user endpoint
runs before the point where that overwrite happened, and was passing the request
headers through untouched — so an admin's own spoofed value became the address
Better Auth recorded and rate-limited against.

Building those headers is now a single helper that takes the request context, so
the correct form is the only form the compiler allows, and a source-level test
fails on any future call site that does not use it.
