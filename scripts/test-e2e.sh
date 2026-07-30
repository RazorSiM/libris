#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker-compose.test.yml"

# --- Cleanup on exit ---
# Default: keep named node_modules/pnpm-store volumes between runs so the
# in-container `pnpm install` is fast on subsequent invocations. Wipe them
# (and the data dirs) only when LIBRIS_E2E_RESET=1.
cleanup() {
  echo "==> Stopping test services..."
  if [ "${LIBRIS_E2E_RESET:-0}" = "1" ]; then
    docker compose -f "$COMPOSE_FILE" --profile e2e down -v 2>/dev/null || true
  else
    docker compose -f "$COMPOSE_FILE" --profile e2e down 2>/dev/null || true
  fi
  rm -rf "$PROJECT_ROOT/tmp/test-inbox" "$PROJECT_ROOT/tmp/test-library"
}
trap cleanup EXIT

# --- Start backing services ---
echo "==> Starting test Postgres (5433) and Redis (6380)..."
docker compose -f "$COMPOSE_FILE" up -d --wait postgres redis

# --- Prepare data dirs (mounted into the playwright container) ---
mkdir -p "$PROJECT_ROOT/tmp/test-inbox" "$PROJECT_ROOT/tmp/test-library"

# --- Run tests inside the playwright container ---
# Browsers are bundled in mcr.microsoft.com/playwright:v1.59.1-noble, which
# avoids the NixOS dynamic-linker mismatch we'd hit running playwright on the
# host. Workspaces' node_modules live in named volumes — we install once per
# lockfile change.
echo "==> Running Playwright tests in container..."
EXIT_CODE=0
docker compose -f "$COMPOSE_FILE" --profile e2e run --rm playwright "$@" || EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "==> All tests passed."
else
  echo "==> Tests failed (exit code $EXIT_CODE)."
fi

exit $EXIT_CODE
