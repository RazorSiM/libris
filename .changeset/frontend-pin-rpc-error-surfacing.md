---
"@libris/web": patch
---

Pin that a refused API call reaches the user as an error.

No behaviour change: this adds the regression coverage that was missing. A
report claimed the credential mutations swallowed HTTP errors — that a 409 from
`PUT /api/credentials/kosync` resolved normally and rendered a green "KoSync
credentials saved" toast for a credential the server had refused.

It does not. Vanilla `hc` resolves on 4xx, but `useApiClient()` installs a fetch
wrapper that throws `ApiError` on any non-ok response and lifts the server's
`error` field into the message, so every mutation built on that client rejects
whether or not it inspects `res.ok` itself. The saved-credential toast is only
reached when the request succeeded.

That guarantee lives in one shared wrapper and had nothing pinning it, which is
the actual fragility. The new tests drive a 409, a 404 and a bodiless 500
through the credential mutations against a real client with only the network
stubbed, and assert the rejection carries the server's message and status. They
go red the moment the throw is removed from the wrapper.
