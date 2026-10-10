#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UI="$ROOT/ui"
SKIP_INSTALL=0
[ "${1:-}" = "--skip-install" ] && SKIP_INSTALL=1
[ "${DSH_UI_SKIP_INSTALL:-0}" = "1" ] && SKIP_INSTALL=1

echo "[ui] unified frontend build (src=$UI)"
[ -d "$UI" ] && [ -f "$UI/package.json" ] || { echo "[ui] ERROR: frontend source missing (expected $UI/package.json)"; exit 1; }

if [ "$SKIP_INSTALL" = 0 ] && [ -f "$UI/package-lock.json" ]; then
  echo "[ui] npm ci (lockfile reproducible build)..."
  (cd "$UI" && npm ci) || { echo "[ui] ERROR: npm ci failed"; exit 1; }
fi

echo "[ui] npm run build -> ui/dist/ ..."
(cd "$UI" && npm run build) || { echo "[ui] ERROR: UI build failed"; exit 1; }
[ -f "$UI/dist/supervisor.html" ] || { echo "[ui] ERROR: supervisor.html missing in build output"; exit 1; }

echo "[ui] mirror -> ui-react/ (guard-hosted/package artifact)..."
rm -rf "$ROOT/ui-react"
cp -r "$UI/dist" "$ROOT/ui-react"
[ -f "$ROOT/ui-react/supervisor.html" ] || { echo "[ui] ERROR: supervisor.html missing in mirror"; exit 1; }

grep -q '<div id="root">' "$ROOT/ui-react/supervisor.html" || { echo "[ui] ERROR: supervisor.html lacks root mount point"; exit 1; }

echo "[ui] build complete:"
echo "    src:   $UI"
echo "    tmp:   $UI/dist"
echo "    mirror: $ROOT/ui-react"
