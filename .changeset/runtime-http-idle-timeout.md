---
"@libris/api-hono": patch
---

Stop cutting off slow-but-legitimate requests with a TCP reset.

`LIBRIS_HTTP_IDLE_TIMEOUT_MS` was applied with `server.setTimeout(ms, socket =>
socket.destroy())`. Despite the name, that is a socket _inactivity_ timeout armed
for the whole life of a connection — including the window in which a request
handler is running and has not yet written any bytes — which is exactly why Node
made `server.timeout` default to 0. Because the callback destroyed the socket
unconditionally, a request that legitimately took longer than the deadline died
mid-flight: the browser saw `ERR_CONNECTION_RESET` with no status code, nothing
reached the access log, and the handler carried on and later wrote into a dead
socket. Opening a book whose cover had to be fetched through the proxy, or any
upload whose processing ran long, could hit this.

The budget is now applied as `keepAliveTimeout`, which is genuinely idle-only: it
starts once a response has been written and bounds the wait for the next request
on that connection. Slowloris protection is unchanged — `headersTimeout` and
`requestTimeout` still bound the receive side, and a client that never finishes
its headers now gets a proper `408 Request Timeout` instead of being reset early
by the old timer. WebSocket connections were never affected and still are not.
