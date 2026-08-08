---
"@libris/web": patch
---

Re-dial the realtime socket when the signed-in user changes.

The events WebSocket was opened once at app bootstrap and never closed or
reopened. The server binds a subscription's user id and admin flag **at upgrade
time** and never re-checks them, and both sign-out and sign-in are SPA
navigations with no page load to reset anything — so the socket outlived the
session it was authenticated with.

On a shared browser that meant an admin could sign out, a regular user could
sign in, and the second user's tab was still holding the first user's
admin-scoped subscription: it received every book event on the install — other
users' book ids, event types and payloads — and none of the second user's own,
so their inbox badge, reading counts and job status silently stopped updating.
That defeats the point of scoping these events per user in the first place.

The socket is now keyed on the signed-in user id: it closes and re-dials
whenever that changes, by whatever route, and none is opened at all while signed
out — which also removes a pointless reconnect loop against a 401 on the login
page. The reported connection status reads CLOSED while signed out rather than
reporting the last value the transport happened to leave behind.

Not addressed here: the server still lets an already-upgraded socket outlive a
revocation of its own session. Closing sockets on revocation is a server-side
change and is left to its own issue.
