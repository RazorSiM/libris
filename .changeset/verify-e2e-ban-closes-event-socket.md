---
"@libris/api-hono": patch
---

Cover the revoked-session socket close from a real browser (libris-zin).

`libris-e0p` made the server sever an open `/api/events` socket with close code
4401 when the credential behind it is revoked, and shipped eleven integration
tests for it — but nothing that exercised the property through the app's own
connection code, because the E2E suite could not be run at the time.

`websocket-events.spec.ts` now has a `@smoke` case that signs a throwaway account
in through the login form, watches the socket the app itself opens
(`page.on("websocket")`, never a hand-rolled one — a second connection would have
its own upgrade and would pass whatever the app's socket was doing), confirms it
receives an event for a book that account owns, bans the account from the admin's
session, and then asserts the two halves of the server's guarantee: the socket
the app opened is closed, and a second fan-out for the same book reaches nothing
— neither the severed socket during its closing handshake nor any socket the
client re-dials with the revoked cookie.

Deliberately says nothing about what the page then shows. How the client reacts
to a 4401 is a separate concern with a separate spec; asserting on it here would
make this test fail for reasons that are not about the server.

Verified red by stubbing `EventSocketRegistry.closeMatching` to a no-op, which
leaves the 60-second re-validation backstop as the only mechanism: the socket
stayed open and the assertion timed out. Restored, the whole file passes (12/12).
