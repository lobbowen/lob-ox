#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ "${GITHUB_ACTIONS:-}" != 'true' ]; then
  echo '拒绝：launcher 构建只允许在 GitHub CI 内运行（GITHUB_ACTIONS=true）。' >&2
  echo '  硬标准：所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物。' >&2
  echo '  本机自查上限是纯静态检查（bash -n / node --check）；构建与回归都由 CI 裁决。' >&2
  exit 2
fi

VER="$(node -p "require('./package.json').version")"

ALL=0
OUT_REL="dist/launcher"
while [ $
  case "$1" in
    --all-platforms) ALL=1 ;;
    -*) echo "未知参数: $1（支持 [outDir] / --all-platforms）"; exit 2 ;;
    *) OUT_REL="$1" ;;
  esac
  shift
done
mkdir -p "$OUT_REL"
OUT="$(cd "$OUT_REL" && pwd)"

. "$ROOT/release/scripts/_platforms.sh"

HOST_PLAT="$(node -p "process.platform")"
HOST_ARCH="$(node -p "process.arch")"
if [ "$ALL" = 1 ]; then
  PLATFORMS="$(dsh_platform_matrix_assert)"
  echo "[0/6] 模式：全平台（一次构建 → 派生 $(printf "%s\n" "$PLATFORMS" | grep -c .) 份元数据包装）"
else
  PLAT="${DSH_PLATFORM_OVERRIDE:-$HOST_PLAT}"
  ARCH="${DSH_ARCH_OVERRIDE:-$HOST_ARCH}"
  case "$PLAT" in linux) OS_TAG=linux;; darwin) OS_TAG=darwin;; win32) OS_TAG=win;; *) echo "不支持的平台: $PLAT"; exit 1;; esac
  PLATFORMS="$OS_TAG $PLAT $ARCH"
  echo "[0/6] 模式：单平台 $OS_TAG-$ARCH"
fi

echo "[1/6] 前端统一构建（release/scripts/build-ui.sh）…"
bash "$ROOT/release/scripts/build-ui.sh"
[ -f "$ROOT/ui-react/supervisor.html" ] || { echo "错误：UI 镜像缺失"; exit 1; }

echo "[2/6] esbuild 打包 bin → core.cjs…（平台无关：仅 --platform=node + 版本注入）"
case "$VER" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "非法 version（只允许点分数字/x-prerelease）：$VER"; exit 1 ;;
esac
ESBUILD_VER="${DSH_ESBUILD_VERSION:-0.25.9}"
npx --yes "esbuild@$ESBUILD_VER" bin/lobox --bundle --platform=node --format=cjs --outfile="$OUT/core.cjs" --define:__DSH_VERSION__="\"$VER\"" >/dev/null
ACTUAL_ESBUILD="$(npx --yes "esbuild@$ESBUILD_VER" --version 2>/dev/null | tr -d '\r' | tail -n1)"
if [ "$ACTUAL_ESBUILD" != "$ESBUILD_VER" ]; then
  echo "esbuild 版本对账失败：期望 ${ESBUILD_VER}，实际 ${ACTUAL_ESBUILD}（固版未生效？）"; exit 1
fi
echo "  esbuild=${ACTUAL_ESBUILD}（固版）；__DSH_VERSION__=${VER}（单源注入）"

echo "[3/6] 派生平台目录…"
DIRS=()
while read -r P_OS P_PLAT P_ARCH; do
  [ -n "${P_PLAT:-}" ] || continue
  DIR="$OUT/lobox-$VER-$P_PLAT-$P_ARCH"
  rm -rf "$DIR"
  mkdir -p "$DIR/bin"
  cat > "$DIR/bin/lobox" <<'LAUNCHER'
'use strict';
require('../core.cjs');
LAUNCHER
  chmod 755 "$DIR/bin/lobox"
  cp "$OUT/core.cjs" "$DIR/core.cjs"
  rm -rf "$DIR/ui-react"
  cp -r "$ROOT/ui-react" "$DIR/ui-react"
  echo "$VER" > "$DIR/version.txt"
  DIRS+=("$DIR")
  echo "  $P_OS-$P_ARCH → $(basename "$DIR")"
done <<< "$PLATFORMS"

if [ "$ALL" = 1 ]; then
  echo "[3/6] 一致性断言：四平台 core.cjs 必须逐字节相同"
  BASE="${DIRS[0]}/core.cjs"
  BASE_HASH="$(sha256sum "$BASE" | awk '{print $1}')"
  for d in "${DIRS[@]}"; do
    h="$(sha256sum "$d/core.cjs" | awk '{print $1}')"
    if [ "$h" != "$BASE_HASH" ]; then
      echo "  FAIL $(basename "$d") core.cjs 与基准不一致（$h != ${BASE_HASH}）"; exit 1
    fi
    printf "  %-42s %s\n" "$(basename "$d")" "${h:0:16}"
  done
  echo "  OK 四平台 core.cjs 同源（sha256=${BASE_HASH:0:16}…）"
fi

for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.3
done

echo "[5/6] 产物清单"
for d in "${DIRS[@]}"; do ls -lh "$d/core.cjs" | awk '{printf "  %-46s %s\n", $9, $5}'; done
echo "[6/6] 完成：$OUT/（launcher 形态，Node >=18 依赖）"
