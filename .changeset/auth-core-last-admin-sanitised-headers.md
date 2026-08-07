---
"@libris/api-hono": patch
---

Pass the server-resolved client address to Better Auth on the last-admin path. `lastAdminMiddleware` called `getSession` with the raw request headers, so on `/api/auth/admin/set-role`, `/ban-user` and `/remove-user` a caller could supply the private client-IP header that `lib/auth.ts` configures Better Auth to trust — the app only overwrites it inside the `/api/auth/*` handler, which runs after this middleware. Every `getSession` call now goes through `withTrustedClientIp`.
