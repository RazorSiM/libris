---
"@libris/api-hono": patch
"@libris/web": patch
---

Stop signing people out when their role changes.

The realtime event socket has its user id and admin flag fixed at the moment it
connects, so when an admin promotes or demotes you the server has to close the
socket and have your browser open a fresh one that knows about the change. It
was closing it with the same code it uses for "your session is gone", and the
browser — correctly, for that code — signed you out and sent you to the login
page. Being granted admin rights logged you out of the app.

There are now two codes. 4401 still means the session is gone (banned, revoked,
signed out elsewhere, expired) and still signs you out. 4409 means the
connection needs rebuilding but your session is untouched, and the browser
simply reconnects, about a second later, with nothing visible happening.

The same applies when a second tab signs in as a different person: that closes
the first tab's socket for rebinding rather than ending the session the new tab
just started.
