#!/usr/bin/env bash
# glibc 基座门禁 —— 单源在 core/ci/check-glibc.sh（本仓合仓：core/ 与 shell/ 同仓，无需跨仓同步）。
# W6：此前 shell 版是 core 版的逐行拷贝（仅措辞/缩进不同）⇒ 同一判据两份，改一处必漏另一处。
# 现在本文件只做转发：把参数原样交给唯一实现，退出码与输出全部透传（调用方无感）。
#   调用点：.github/workflows/shell.yml（传 ${{ matrix.glibc_max }}）。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IMPL="$HERE/../../core/ci/check-glibc.sh"
[ -f "$IMPL" ] || { echo "  ❌ 找不到 glibc 门禁单源: $IMPL（合仓内路径不变）"; exit 2; }
exec bash "$IMPL" "$@"
