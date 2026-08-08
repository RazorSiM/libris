---
"@libris/web": patch
---

Make the app's idea of who is signed in a single source of truth.

`useAuth()` is a plain function with no memoisation, and a dozen call sites call
it separately — the router guard, the settings page, several settings
components, the mutation composables. The generation counter and the
single-flight promise that keep a session read honest were declared **inside**
that function, so each caller got its own private pair and neither guarded
anything across the callers that actually race.

The failure it was written to prevent therefore still happened. Saving your name
on the account tab calls `refresh()` on the mutation composable's instance;
clicking Logout in the settings navbar bumps a counter on the settings page's
instance. The in-flight session read compared against its own untouched counter,
passed, and wrote the old identity back into the shared store — the user watched
themselves get signed back in on a dead cookie. Two concurrent `check()` calls
from different instances also issued two `getSession()` requests instead of one.

Both now live in the `auth` store alongside `checked`, so every consumer shares
them, and `login()`, `logout()` and `refresh()` all route through one
`beginNewSession()`. `login()` needed it too: signing in while a previous
identity's session read was still open could adopt **that** answer as the new
session. `logout()` also clears local state before the network round-trip rather
than after, so the UI is never rendering a signed-in shell for a session the
user has already ended.

The unit tests now use two independent `useAuth()` instances, which is the only
topology that occurs in production. They fail if the counters move back into the
function body; the previous single-instance test could not.
