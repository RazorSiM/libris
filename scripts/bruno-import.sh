#!/usr/bin/env bash
# Imports the OpenAPI spec into a Bruno collection.
# Usage: ./scripts/bruno-import.sh
#
# If the API server is already running on port 3000, it uses it directly.
# Otherwise, it starts a lightweight OpenAPI-only server (no DB/Redis needed).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
API_URL="${API_URL:-http://localhost:3000}"
BRUNO_DIR="$ROOT_DIR/bruno"
COLLECTION_NAME="Libris API"

started_server=false

cleanup() {
  if [ "$started_server" = true ] && [ -n "${server_pid:-}" ]; then
    echo "Stopping dev server (PID $server_pid)..."
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

check_openapi() {
  curl -sf "$API_URL/_docs/openapi.json" -o /dev/null 2>&1
}

# Check if server is already running
if check_openapi; then
  echo "API server already running at $API_URL"
else
  echo "Starting lightweight OpenAPI server..."
  pnpm exec tsx "$ROOT_DIR/services/api-hono/src/openapi-server.ts" >/dev/null 2>&1 &
  server_pid=$!
  started_server=true

  # Wait for OpenAPI endpoint to be ready (up to 30s)
  for i in $(seq 1 30); do
    if check_openapi; then
      echo "Server ready after ${i}s"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "ERROR: Server failed to start within 30s" >&2
      exit 1
    fi
    sleep 1
  done
fi

# Fetch the OpenAPI spec
echo "Fetching OpenAPI spec from $API_URL/_docs/openapi.json..."
spec_file=$(mktemp /tmp/openapi-XXXXXX.json)
curl -sf "$API_URL/_docs/openapi.json" -o "$spec_file"

if [ ! -s "$spec_file" ]; then
  echo "ERROR: Failed to fetch OpenAPI spec" >&2
  exit 1
fi

# Preserve environment files if they exist
env_backup=""
if [ -d "$BRUNO_DIR/environments" ]; then
  env_backup=$(mktemp -d /tmp/bruno-env-XXXXXX)
  cp -r "$BRUNO_DIR/environments/"* "$env_backup/" 2>/dev/null || true
fi

# Remove existing collection (fresh import)
if [ -d "$BRUNO_DIR" ]; then
  echo "Removing existing Bruno collection..."
  rm -rf "$BRUNO_DIR"
fi

# Import into Bruno collection
echo "Importing OpenAPI spec into Bruno collection..."
bru import openapi \
  --source "$spec_file" \
  --output "$BRUNO_DIR" \
  --collection-name "$COLLECTION_NAME" \
  --group-by tags

rm -f "$spec_file"

# Remove internal/test endpoints
rm -rf "$BRUNO_DIR/Internal"

# Restore or create environment files
mkdir -p "$BRUNO_DIR/environments"

if [ -n "$env_backup" ] && [ -d "$env_backup" ]; then
  cp -r "$env_backup/"* "$BRUNO_DIR/environments/" 2>/dev/null || true
  rm -rf "$env_backup"
  echo "Restored environment files"
else
  cat > "$BRUNO_DIR/environments/Local.bru" << 'ENVEOF'
vars {
  baseUrl: http://localhost:3000
}
ENVEOF
  echo "Created default Local environment"
fi

echo ""
echo "Bruno collection generated at: $BRUNO_DIR"
echo "Open it in Bruno GUI or run: bru run --env Local bruno/"
