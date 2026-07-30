---
"@libris/api-hono": patch
"@libris/web": patch
"@libris/docs": patch
---

Port CI/CD from Forgejo Actions to GitHub Actions, and publish images to GHCR.

`.github/workflows/ci.yml` replaces `.forgejo/workflows/ci.yml`: jobs move to
`ubuntu-latest`, `setup-vp` loses its Forgejo-only full-URL form, and the
artifact actions go to v4 (v3 was shut down on github.com in January 2025). The
separate `e2e-pr` and `e2e-main` jobs are merged into one `e2e` job that selects
the `@smoke` subset on pull requests and the full suite on pushes, so the
service, container, and env setup can no longer drift between them. Shards go
from 2 to 3, and a `concurrency` group cancels superseded runs. The bespoke
PR-comment step that called the Forgejo issues API is dropped — GitHub's native
checks UI already reports per-shard status.

`.github/workflows/release.yml` replaces `publish-images.yml` and switches the
release strategy to `changesets/action@v1`. Releases are now PR-gated: merging
to main opens a "chore: version packages" PR, and merging that is what triggers
the release. The action runs without a `publish` input, since no workspace goes
to npm.

The old two-job split existed only because the Forgejo runners were split — one
had Node without a Docker daemon, the other a daemon without Node. A GitHub
runner has both, so the `ci/release-<run_id>` staging branch, the re-clone, and
the rebase-onto-main are all gone. Publishing is idempotent via the existing
composite-tag registry check, so no commit-message sniffing is needed to detect
the version merge. Registry auth uses the built-in `GITHUB_TOKEN`, retiring the
`REGISTRY_TOKEN` secret, and the build gains buildx with a GitHub Actions layer
cache.

Docs and agent instructions follow: `docs/ci-cd.md` is rewritten for the new
workflows and documents the release flow, `docs/deployment.md` points at
`ghcr.io/razorsim/libris`, and `fj` is replaced by `gh` throughout AGENTS.md,
CLAUDE.md, README.md, and `docs/contributing.md`.
