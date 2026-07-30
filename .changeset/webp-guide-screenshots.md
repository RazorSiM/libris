---
"@libris/api-hono": patch
"@libris/web": patch
"@libris/docs": patch
---

Convert the user-guide screenshots from PNG to WebP.

All 29 images in `docs/guide/images/` are now WebP at quality 90 (`webp:method=6`),
and every reference in `README.md` and `docs/guide/*.md` was rewritten to match.

This was the dominant cost in the repo: the PNGs were 7.9MB of a 12MB tracked
tree, all of them unoptimized retina-scale captures at 1376x1403. WebP brings
that to 1.8MB, a 77% reduction, taking the whole tracked tree from 12MB to 5.4MB
— a cost every clone was paying.

Quality 90 was chosen after measuring: PSNR 41.6dB, and a 1:1 crop of a
text-dense region is visually indistinguishable from the original, which matters
because these are UI screenshots where readers need to make out interface text.

Application images are deliberately untouched — `apps/web/public/` favicons and
PWA icons must stay PNG/ICO for manifest and `apple-touch-icon` compatibility,
and the logos are already SVG.
