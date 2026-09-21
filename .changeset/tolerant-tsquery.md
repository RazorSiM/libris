---
"@libris/api-hono": patch
---

Make search tolerant of punctuation. All four search endpoints (/api/search, /api/library, /api/inbox, /opds/search) shared a sanitizer that stripped most tsquery operators but not the apostrophe, so a query such as `foo&'` built a tsquery Postgres rejects and answered 500. They now share `buildPrefixTsquery`, which drops apostrophes so `children's` still reaches the English stemmer as one word and replaces every other syntax character (including `-`, which silently meant "phrase") with a separator, returning null — and therefore an unfiltered or empty result — when nothing searchable remains.
