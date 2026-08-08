---
"@libris/api-hono": patch
---

Stop the schema-drift test from reporting a slow run as schema drift.

The migrations-vs-`schema.ts` check ran `drizzle-kit`'s `pushSchema` under
Vitest's default 30s timeout. On a loaded machine that budget expired, and the
failure surfaced as `migrations > leaves no drift ... Test timed out in
30000ms` — a name that sends whoever reads it hunting a schema/migration
mismatch that does not exist.

The check now runs in two tests: a probe that asks drizzle-kit the question
under an explicit, generous timeout, and the drift assertion itself. A run that
is merely too slow fails the probe, under a name that makes no claim about the
schema and with an explicit "NOT DRIFT — no comparison was performed" note; the
drift assertion is skipped rather than reported red. What the drift check
actually verifies is unchanged: it still fails on any statement drizzle-kit
would still have to run.
