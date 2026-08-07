---
"@libris/api-hono": patch
"@libris/web": patch
---

Fix E2E specs that asserted nothing, or could not be re-run.

Four cases where a green test proved less than it looked like it did:

- **`auth.spec.ts` "user management"** walked a fixed `housemate@example.test`
  account through create, promote, reset, ban and demote, and never deleted it.
  Playwright restarts a serial group from its first test on retry and CI runs
  with `retries: 2`, so a retry found the previous attempt's account —
  `create-user` 409'd, but the assertion was a list row that the leftover
  satisfied, so the test reported PASSED and the real failure surfaced two tests
  later as a misleading role error. The block now deletes the account before and
  after itself, and asserts the create-user response rather than inferring
  success from a row that may pre-date the click.
- **`isolation.spec.ts` concurrent upload** asserted only that both uploads
  returned 200 with one entry each. The route echoes the client-supplied
  filename, never the name actually written, so the response was identical
  whether the second write took the collision-safe rename or truncated the first
  file. It now reads the inbox directory and asserts two distinct files whose
  bytes both match the fixture.
- **`websocket-events.spec.ts` job events** emitted `job:failed` and then
  re-asserted the same thing it had asserted before emitting. It now waits for
  the `GET /api/settings/status` refetch the event's query invalidation causes.
- **OPDS revocation immediacy**, lost when `multi-user-auth.spec.ts` was
  deleted, is restored: revoking an app password stops it opening `/opds`
  immediately, and rotating one retires the old credential while admitting the
  new one in the same instant.
