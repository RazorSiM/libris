---
"@libris/api-hono": patch
---

Fix Redis URL credential parsing: an ACL username in `REDIS_URL` (from `REDIS_USER`) is now passed to ioredis, and percent-encoded usernames and passwords are decoded, so credentials containing reserved characters authenticate.
