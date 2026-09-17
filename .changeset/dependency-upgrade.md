---
"@libris/web": patch
---

Dependency and toolchain upgrade pass: Vite+ 0.3.2 (Vite 8.2.2 core, upstream Vitest 4.1.11, Oxlint 1.82, Oxfmt 0.67), Nuxt UI 4.11.1, and pnpm security floors for postcss, nanoid, esbuild and Tiptap. `pnpm audit --prod` is now clean. Each package that declares `vite-plus` also carries a direct `vite` dev dependency so pnpm resolves the Vite+ core alias for plugin peers instead of auto-installing a separate registry Vite.
