---
"@libris/api-hono": patch
---

Upgrade drizzle-orm and drizzle-kit from 1.0.0-beta.21 to 1.0.0-rc.4.

The 1.0.0-beta line is deprecated on npm; rc.4 is the current `rc` dist-tag for
both packages. They move together -- same release train.

The previously recorded blocker ("Better Auth's Drizzle connector is
incompatible with the RC") does not hold up. `@better-auth/drizzle-adapter` has
no type-level coupling to drizzle-orm at all, and the pnpm peer warning it
produces is byte-for-byte identical on beta.21 and rc.4, because both fail its
declared `^0.45.2` range equally. `vp install` exits 0 either way.

The one real breaking change is drizzle's own removal of relational-queries v1:
`DrizzlePgConfig` no longer accepts `schema`, and the driver's first type
parameter is now the relations config rather than the schema. `createDb` and the
PGlite test helper pass `relations` alone; `defineRelations(schema, ...)` already
carries every table, so `db.query.*` is unaffected.

One consequence is load-bearing rather than cosmetic: with RQB v1 gone the
driver no longer exposes `_.fullSchema`, which is where `drizzleAdapter` falls
back when no `schema` is passed. The explicit `schema` argument at the
`drizzleAdapter` call site is now the only thing keeping Better Auth from
throwing "Drizzle adapter failed to initialize. Schema not found." at startup,
and is commented as such.

No migration churn: `drizzle-kit generate` reports no schema changes and
`drizzle-kit check` passes against the existing migration folder.
