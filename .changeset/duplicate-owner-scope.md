---
"@libris/api-hono": patch
---

Stop a book's `possibleDuplicate` link from leaking another user's private upload. The metadata worker writes the duplicate id with no owner predicate, and the inbox detail route resolved and returned it for any caller, exposing the target's title, author and status (and its existence). The lookup now follows the same visibility rule as the rest of the inbox — own books plus the shared organized library, everything for admins — and the raw `possibleDuplicateOf` FK is no longer part of any API response; only the resolved, visibility-checked object is.
