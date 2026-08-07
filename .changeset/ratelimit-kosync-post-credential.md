---
"@libris/api-hono": patch
---

Give `POST /kosync/users/auth` the same per-credential brute-force budget the GET form already had. The POST form carries the username in its JSON body rather than in `x-auth-user`, so failed attempts only ever counted against the source address and an attacker rotating addresses never exhausted a budget — against the endpoint that takes the plaintext KoSync password.
