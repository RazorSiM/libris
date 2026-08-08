---
"@libris/api-hono": patch
---

Close a live event stream when the session behind it is revoked.

Signing out from another device, an admin ban, an admin-set password or plain
expiry stopped every HTTP request a person could make — and left their open
`/api/events` WebSocket streaming. A socket authenticates once, at upgrade, and
then never asked again, so it outlived the credential that opened it for as long
as the tab stayed open. Enforcing bans on every credential path made the gap
visible: a banned user's downloads stopped dead while their event feed carried
on.

Revocation now reaches the socket two ways, because either one alone has a hole.

**Immediately, from Better Auth's database hooks.** A socket closes the moment
its session row is deleted, the moment its owner is written as banned, and the
moment the account is removed. These hook the database write rather than the
endpoint, which is the point: sign-out, revoke-session, revoke-sessions,
revoke-other-sessions, change-password, delete-user, ban-user, update-user with
`banned`, set-user-password, revoke-user-session, revoke-user-sessions and
remove-user all funnel through the same four adapter calls, so there is no list
of endpoints to keep current — and a hook on the write cannot fire for a request
that was refused, which is how an earlier endpoint hook turned an unauthenticated
POST into a credential-free sign-out.

**Then on a 60-second timer, as the backstop.** An open socket re-resolves its
own credential and closes if the session is gone, the account is banned, the
identity changed or the role changed. This covers what no hook can see: a session
that merely _expired_ (nothing deletes it, so nothing fires), an app password
that was disabled (those sockets have no session row at all), and a revocation
served by another process.

An unreachable Redis or Postgres is explicitly not treated as revocation. A
degraded store leaves sockets open rather than severing every event stream on the
install.

The subscription is torn down before the transport, so a closed socket receives
nothing rather than receiving whatever lands during the closing handshake, and
its connection slot goes straight back to the per-principal cap — a banned user
who is later unbanned does not find their budget permanently spent.
