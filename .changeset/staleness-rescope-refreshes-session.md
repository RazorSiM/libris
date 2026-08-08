---
"@libris/web": patch
---

Refresh the signed-in session when the server re-scopes the event socket (libris-cxy).

A role or identity change closes the event socket with 4409 so it can be rebound
with the current scope. The socket came back correct; the app did not. Being
promoted to admin gave you an admin-scoped event feed behind a sidebar with no
admin navigation, and an identity change left the chrome naming the previous
user — for the life of the tab, because the session is only read once per page
load.

A 4409 now refreshes the session before reconnecting, and the reconnect is
performed once: the transport's own retry is suspended for that close so it
cannot race the re-dial the identity change triggers, which would have left two
sockets open for one principal and the next re-scope refused by the
per-principal connection cap.
