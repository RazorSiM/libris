---
"@libris/api-hono": patch
---

Cap inbound WebSocket frames at 64 KiB. The event socket only acts on the literal `"ping"` text, but `ws` defaults to a 100 MiB frame limit, so an authenticated client could make the process buffer hundreds of MiB across its allowed sockets and have every byte discarded. Oversized frames now close the connection with code 1009.
