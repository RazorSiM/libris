---
"@libris/api-hono": patch
---

Refuse an oversized credential body instead of letting it escape its
per-credential rate-limit bucket. To bucket brute-force attempts by the account
being guessed rather than the source address, the rate limiter reads the email
or username out of the JSON body of `POST /api/auth/sign-in/email` and
`POST /kosync/users/auth` — but it declined to parse anything over 8 KB and fell
back to the per-IP tiers. On the sign-in path there are no per-IP tiers of ours
(the whole `/api/auth/` prefix is left to Better Auth's own limiter), so padding
the sign-in JSON past 8 KB dropped the attempt out of the per-credential budget
into nothing, and an attacker rotating source addresses spent no budget at all.
The 1 MB body limit in front of the limiter did not cover this: 8 KB to 1 MB
passed straight through it.

Such a body is now answered with 413, and the ceiling is measured against the
decoded body rather than trusting the declared `content-length`, so omitting the
header no longer sidesteps it. No legitimate sign-in or KOReader login body is
anywhere near 8 KB.
