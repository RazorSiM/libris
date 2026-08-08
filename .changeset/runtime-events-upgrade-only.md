---
"@libris/api-hono": patch
---

Stop a plain HTTP GET to `/api/events` from consuming a WebSocket connection
slot.

`upgradeWebSocket` runs its setup callback on every GET to the route, and the
node adapter only bails out afterwards when the request carries no
`Upgrade: websocket`. The slot reservation lived in that callback, so an
ordinary request reserved a connection that `onOpen`/`onClose`/`onError` never
released — the only thing that gave it back was a ten-second timer. Five plain
`curl /api/events` in under a second were therefore enough to keep one user's
real browser socket rejected with 429, and a caller holding roughly twenty app
passwords could pin the process-wide cap and deny the live event stream to
everyone on the server, without ever opening a WebSocket.

The route now refuses a non-upgrade request with 400 before reserving anything,
which also stops `/api/events` falling through to the SPA fallback and answering
200 `text/html`. The reservation timer is `unref`'d so pending handshakes cannot
hold the process open at shutdown.
