---
"@libris/docs": patch
---

Developer environment: install `agent-browser` in `devenv.nix` and point it at the Nix-provided Playwright Chromium via `AGENT_BROWSER_EXECUTABLE_PATH`. That skips `agent-browser install`, which downloads Chrome for Testing and cannot run on NixOS, so agents and humans can drive the running SPA and capture screenshots from the devenv shell. Documented in `docs/contributing.md`.

The same commit takes the pending `devenv.lock` bump (the previous pin only reached `agent-browser` 0.27.0) and realigns `@playwright/test` to 1.64.1 — the version that nixpkgs' `playwright-driver` now ships — across the workspace catalog, `docker-compose.test.yml` and both `ci.yml` jobs. Host runs resolve browsers from the revision compiled into the client, so the catalog and the nixpkgs browser cache have to agree; `devenv.yaml` and `docs/contributing.md` now record that invariant and how to check it after `devenv update`.
