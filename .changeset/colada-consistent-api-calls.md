---
"@libris/web": patch
---

Route every remaining API call through Pinia Colada.

Three places still hand-rolled what the query cache already does — their own
`loading` and `error` refs around a `try`/`catch`/`finally` — so their responses
were invisible to the cache, could not be deduplicated between callers, and were
never invalidated by anything.

- **Hardcover search** (the metadata autofill panel) and the **command palette**
  are now debounced Colada queries keyed on the search term. Retyping a term you
  just searched for is served from the cache instead of spending another request,
  and two components asking the same thing share one. The palette also stops
  discarding failures in a bare `catch` — on screen it still shows the navigation
  links and no books, but the failure is now readable rather than gone.
- **Refetch metadata** reads the book's candidates through the query cache, so
  the result is stored under the book's key and dropped by the same invalidation
  every other book mutation issues, instead of living in a component-local ref.

No visible change. Hardcover search still distinguishes "you have not connected
a Hardcover credential" (muted guidance pointing at Settings) from a genuine
failure (a red error line), which is now covered by tests.
