---
"@libris/api-hono": patch
---

Compare the full canonical origin (scheme, host, and port) for cookie-authenticated mutations and WebSocket upgrades. A same-host origin on a different port — which `SameSite` cookies cannot separate, since they are site-scoped rather than port-scoped — is now rejected with 403, and valid IPv6 origins such as `http://[::1]:3000` are accepted instead of rejected. The scheme comes from `x-forwarded-proto` only when `TRUST_PROXY_HEADERS=1`; reverse proxies should forward it (see _Reverse Proxy_ in the deployment docs).
