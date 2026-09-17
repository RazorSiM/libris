---
"@libris/api-hono": patch
---

Stop logging raw Better Auth keys when Redis degrades. A key embeds live material — a session token, a single-use verification token, or `<ip>|<path>` for a rate-limit counter — and a log line is a copy kept longer and read more widely than Redis. Failure warnings now carry a category (`credential`, `rate-limit`, `active-sessions`) and a truncated SHA-256 so lines still correlate without exposing the secret.
