---
"@libris/api-hono": patch
---

Harden remote cover fetching against redirect SSRF, DNS rebinding, special-use address gaps, oversized responses, missing content types, and forged image metadata. Administrators can explicitly allow trusted private-network cover origins with `LIBRIS_COVER_FETCH_ALLOWLIST`.
