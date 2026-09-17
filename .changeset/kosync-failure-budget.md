---
"@libris/api-hono": patch
---

Close two KoSync brute-force gaps. `POST /kosync/users/auth` is now bucketed by the username in the JSON body — the value the handler verifies — instead of `x-auth-user`, so a header that disagrees with the body can no longer buy a fresh budget per guess. The progress routes (`GET`/`PUT /kosync/syncs/progress`) now share the per-user credential budget, with only failed checks counted: a locked-out identity is refused with 429 before verification, a device that keeps syncing never spends the budget, and a verified check clears recorded failures.
