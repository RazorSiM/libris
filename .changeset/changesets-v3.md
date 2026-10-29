---
"@libris/api-hono": patch
---

Release tooling: move to `@changesets/cli` v3 to match `changesets/action` v2, which Dependabot bumped and which refuses CLI v2. The config now opts private packages back into versioning (`privatePackages.version`), since v3 stopped versioning them by default and every workspace here is private.
