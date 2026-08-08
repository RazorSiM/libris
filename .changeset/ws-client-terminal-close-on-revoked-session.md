---
"@libris/web": patch
---

Stop a revoked tab re-dialling forever, and tell the person why.

The server closes a realtime event socket with code 4401 when the session behind
it stops being valid — you were banned, an admin revoked the session, you signed
out from another device, it expired. The browser treated that like a dropped
connection and re-dialled forever behind a 30-second backoff. The visible result
was a page that quietly stopped updating and never explained itself: you only
found out you were signed out if some unrelated request happened to fail. The
invisible result was one reconnect attempt every 30 seconds, per abandoned tab,
for as long as it stayed open.

4401 is now terminal. The tab stops reconnecting and goes through the same
sign-out-and-redirect the app already uses when a request comes back 401, so you
land on the sign-in page with your destination preserved instead of staring at a
frozen one.

Only that code. A dropped connection, a server restart, a proxy timeout or a
missed heartbeat all still reconnect indefinitely, exactly as before — being
signed out by a flaky network would be a worse bug than the one this fixes.
