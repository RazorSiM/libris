---
"@libris/docs": patch
---

Realign the `vite` catalog alias with the installed Vite+

The catalog aliases `vite` to `@voidzero-dev/vite-plus-core` pinned to the exact
version `vite-plus` itself depends on. The dependency bump moved `vite-plus` to
0.2.8 but left the alias on 0.2.6, so two copies of the core were installed.

Core 0.2.6 does not declare the platform-native packages as its own optional
dependencies — it reaches the Rolldown binding through `vite-plus/binding`, an
export that 0.2.8 no longer has. Anything resolving `vite` through the catalog,
which is how the docs build reaches it, died with "Cannot find native binding".
