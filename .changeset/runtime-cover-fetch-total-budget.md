---
"@libris/api-hono": patch
---

Make the cover-fetch timeout bound the whole operation instead of each redirect
hop.

`timeoutMs` was passed to the per-hop request inside the redirect loop, and the
default implementation built a fresh `AbortSignal.timeout` from it every time, so
with five permitted redirects the real ceiling was six times the configured
value: 60 s for the cover proxy that asks for 10 s, and 180 s for the organize
worker that asks for 30 s. DNS was not bounded at all — each hop's lookup ran
untimed before the timed request — so a hostile nameserver could add
unbounded time on top of every hop.

A host that answered each permitted redirect just under the per-hop limit and
then hung could therefore occupy a request handler for a minute per
`GET /api/books/{id}/cover`, and park the concurrency-1 organize worker for
three minutes per book, stalling the whole ingestion queue behind it.

One deadline is now created before the redirect loop and shared by every hop and
every DNS lookup, so `timeoutMs` means what its callers assume. `assertNotInternalUrl`
takes the same bound.
