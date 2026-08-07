---
"@libris/api-hono": patch
---

Give each IPv4 client its own rate-limit bucket on a dual-stack listener. IPv4 peers reported as IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) were all aggregated into one `/64` bucket, so a single machine could exhaust the general and auth budgets for every IPv4 user at once. Client addresses are now unwrapped to their dotted-quad form everywhere: rate-limit keys, access logs, the Better Auth client-IP header and trusted-proxy matching.
