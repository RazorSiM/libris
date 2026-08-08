---
"@libris/api-hono": patch
---

Replace the obsolete skipped OPDS suite with live-server coverage for cover and
ebook streaming.

Feed structure, search, language filtering, authentication and the content-type
contracts moved to `services/api-hono/src/routes/opds.test.ts`, where they run
against PGlite with no server. What is left in `opds.spec.ts` is the two cases
that genuinely need the configured library directory and a running process:
streaming a cover and streaming an ebook off the real filesystem.

(Previously this changeset named only `@libris/e2e`, which is in the `ignore`
list in `.changeset/config.json` — so it produced no version bump and no
CHANGELOG entry at all.)
