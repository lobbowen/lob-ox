#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMPL="$HERE/../../core/ci/check-glibc.sh"
[ -f "$IMPL" ] || { echo "  ❌ 找不到 glibc 门禁单源: $IMPL（合仓内路径不变）"; exit 2; }
exec bash "$IMPL" "$@"
