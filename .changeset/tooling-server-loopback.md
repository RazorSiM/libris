---
"@libris/api-hono": patch
---

Bind the OpenAPI-only tooling server to loopback. `openapi-server.ts` serves a router with no auth middleware (started by `bruno-import.sh`), and `serve()` without a hostname listened on every interface; it now binds `127.0.0.1` so the tooling port is not reachable from the network.
