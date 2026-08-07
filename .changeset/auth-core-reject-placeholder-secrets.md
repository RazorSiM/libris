---
"@libris/api-hono": patch
---

Reject placeholder and low-diversity `BETTER_AUTH_SECRET` values at startup. `.env.example` shipped the secret pre-filled with a 46-character placeholder that satisfied the old `min(32)` check, so any install that copied the file booted signing sessions with a value published in the repository. `BETTER_AUTH_SECRET` now uses the same blocklist and character-diversity rules as `API_SECRET_KEY`, and `.env.example` ships it blank.
