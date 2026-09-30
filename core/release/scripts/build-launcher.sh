#!/usr/bin/env bash
# 内核统一发布物。
# 背景：Node SEA 单文件二进制在 macOS 上注入后即段错误（最小 hello-world SEA 亦崩，
# 与代码/codecache/codesign 无关 = Node SEA 在 mac 的上游缺陷，铁证）。为彻底消除平台差异，
# 全平台统一发布「Node launcher」npm 包：esbuild bundle + node 启动脚本 + ui-react。
# 产物（dist/launcher/）：
#   dsh-supervisor-<ver>-<platform>-<arch>/
#     +-- bin/dsh-supervisor        # node shebang 启动脚本（require ./core.cjs）
#     +-- core.cjs                  # esbuild 单文件 bundle（含 __DSH_VERSION__ 注入）
#     +-- ui-react/                 # 面板发布镜像
# 依赖：Node.js >=18 运行时（非 SEA 免运行时——发布物需目标机有 node）。
#
# 用法（**只允许在 GitHub CI 内运行**，见下面的守卫）:
#   release/scripts/build-launcher.sh [outDir]          # 单平台（按宿主；可用 DSH_*_OVERRIDE 指定）
#   release/scripts/build-launcher.sh --all-platforms   # **一次构建**产出全部 4 个平台目录
#
# 为什么 --all-platforms 是「一次构建 + 派生四份」而非「构建四次」：
#   launcher 是**纯 JS 产物**——内核依赖数为 0、产物中 .node 文件数为 0，平台差异**仅**体现在
#   npm 的 os/cpu 元数据与目录名。实测同一 bundle 在 linux/win32/darwin 三种覆盖下 sha256 完全一致。
#   故正确做法是构建一次再派生元数据包装：既省时，也从**构造上保证**四平台代码同源
#   （历史上曾因三平台在不同时间点各自构建，导致同版本 mac/win 与 linux 代码不一致）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# 硬标准：**任何平台构建都必须经 GitHub CI**，本地不得产生发布产物。
#   守卫放在参数解析之前、覆盖全部调用形态：此前只有 `--all-platforms` 分支带守卫，
#   单平台路径无守卫，等于这条旁路只封了一半（规范禁止本机跑 build:launcher，脚本却不拦）。
#   CI 的 test job 需要四平台产物供 T6-d/T6-e 断言，故 CI 内照常放行。
if [ "${GITHUB_ACTIONS:-}" != 'true' ]; then
  echo '拒绝：launcher 构建只允许在 GitHub CI 内运行（GITHUB_ACTIONS=true）。' >&2
  echo '  硬标准：所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物。' >&2
  echo '  本机自查上限是纯静态检查（bash -n / node --check）；构建与回归都由 CI 裁决。' >&2
  exit 2
fi

VER="$(node -p "require('./package.json').version")"

ALL=0
OUT_REL="dist/launcher"
while [ $# -gt 0 ]; do
  case "$1" in
    --all-platforms) ALL=1 ;;
    -*) echo "未知参数: $1（支持 [outDir] / --all-platforms）"; exit 2 ;;
    *) OUT_REL="$1" ;;
  esac
  shift
done
mkdir -p "$OUT_REL"
OUT="$(cd "$OUT_REL" && pwd)"

# shellcheck source=./_platforms.sh
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
# B23/B26：
#  1) 版本形态硬校验后才进 --define 插值 —— 防含引号/空格/$ 的 version 破坏参数或注入 shell。
#  2) npx 浮动拉包 = 同 commit 不同天构建结果可能不同（esbuild 新 release 悄悄换默认行为）。
#     固版：默认锁一个已验证版本，DSH_ESBUILD_VERSION 显式覆盖；构建后复跑 --version 对账，
#     不一致即失败（npx 拉不到固版会自行报错，不会静默回退别的版本）。
case "$VER" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "非法 version（只允许点分数字/x-prerelease）：$VER"; exit 1 ;;
esac
ESBUILD_VER="${DSH_ESBUILD_VERSION:-0.25.9}"
npx --yes "esbuild@$ESBUILD_VER" bin/dsh-supervisor --bundle --platform=node --format=cjs --outfile="$OUT/core.cjs" --define:__DSH_VERSION__="\"$VER\"" >/dev/null
ACTUAL_ESBUILD="$(npx --yes "esbuild@$ESBUILD_VER" --version 2>/dev/null | tr -d '\r' | tail -n1)"
if [ "$ACTUAL_ESBUILD" != "$ESBUILD_VER" ]; then
  echo "esbuild 版本对账失败：期望 ${ESBUILD_VER}，实际 ${ACTUAL_ESBUILD}（固版未生效？）"; exit 1
fi
echo "  esbuild=${ACTUAL_ESBUILD}（固版）；__DSH_VERSION__=${VER}（单源注入）"

echo "[3/6] 派生平台目录…"
DIRS=()
while read -r P_OS P_PLAT P_ARCH; do
  [ -n "${P_PLAT:-}" ] || continue
  DIR="$OUT/dsh-supervisor-$VER-$P_PLAT-$P_ARCH"
  rm -rf "$DIR"
  mkdir -p "$DIR/bin"
  # node 启动脚本（bin/dsh-supervisor：npm bin 链接入口）
  cat > "$DIR/bin/dsh-supervisor" <<'LAUNCHER'
#!/usr/bin/env node
'use strict';
// 统一 launcher 启动器。require 同目录 core.cjs（esbuild bundle）。
require('../core.cjs');
LAUNCHER
  chmod 755 "$DIR/bin/dsh-supervisor"
  cp "$OUT/core.cjs" "$DIR/core.cjs"
  # 携带 ui-react（src/api/index.js 候选2) <exe>/../ui-react 解析：pkg/bin/dsh-supervisor -> pkg/ui-react）
  rm -rf "$DIR/ui-react"
  cp -r "$ROOT/ui-react" "$DIR/ui-react"
  # 版本自检文件（供 self-check/版本核对复用）
  echo "$VER" > "$DIR/version.txt"
  DIRS+=("$DIR")
  echo "  $P_OS-$P_ARCH → $(basename "$DIR")"
done <<< "$PLATFORMS"

# 全平台模式：断言四份 core.cjs 逐字节一致（从构造上保证；此断言防未来改动破坏该不变量）
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

echo "[4/6] 冒烟：launcher self-check + --version + fresh-HOME daemon + UI 服务断言"
# 冒烟只需跑一次（bundle 与平台无关）；优先用与宿主平台匹配的那份目录。
SMOKE_DIR=""
for d in "${DIRS[@]}"; do
  case "$d" in *"-$HOST_PLAT-$HOST_ARCH") SMOKE_DIR="$d" ;; esac
done
[ -n "$SMOKE_DIR" ] || SMOKE_DIR="${DIRS[0]}"
echo "  使用 ${SMOKE_DIR##*/}"
# bin/dsh-supervisor 需从 npm 安装语义（node bin）——直接 node 执行验证
node "$SMOKE_DIR/bin/dsh-supervisor" self-check
VOUT="$(node "$SMOKE_DIR/bin/dsh-supervisor" --version)"
echo "  --version => $VOUT"
case "$VOUT" in *v$VER) : ;; *) echo "冒烟失败：版本注入失效"; exit 1;; esac
SMOKE_HOME="$(mktemp -d)"
cat > "$SMOKE_HOME/config.json" <<EOF
{
  "command": ["sleep", "3600"],
  "healthUrl": "http://127.0.0.1:3198/",
  "apiHost": "127.0.0.1",
  "apiPort": 3199,
  "stateFile": "$SMOKE_HOME/state.json",
  "logFile": "$SMOKE_HOME/events.log",
  "supervisorLogFile": "$SMOKE_HOME/guard.log",
  "notifyEnabled": false
}
EOF
SMOKE_LOG="$SMOKE_HOME/boot.log"
# 跨平台 daemon 冒烟：不用 GNU `timeout`（macOS BSD 无此命令）。直接后台 node（$! = node pid），
# 断言后 kill node pid 清理。守卫 spawn 的 sleep 子进程由守卫自身生命周期管理，冒烟结束即无碍。
HOME="$SMOKE_HOME" DSH_SUPERVISOR_CONFIG="$SMOKE_HOME/config.json" DSH_SUPERVISOR_LOCK_FILE="$SMOKE_HOME/guard.lock" node "$SMOKE_DIR/bin/dsh-supervisor" daemon >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
sleep 2
if ! grep -q "guard started v$VER" "$SMOKE_LOG" 2>/dev/null; then
  echo "冒烟失败：fresh-HOME daemon 未能自举"; cat "$SMOKE_LOG" 2>/dev/null | head -8; kill "$SMOKE_PID" 2>/dev/null || true; rm -rf "$SMOKE_HOME"; exit 1
fi
echo "  fresh-HOME daemon 自举 OK"
UI_BODY="$(curl -s -m 2 "http://127.0.0.1:3199/" 2>/dev/null || true)"
if ! printf "%s" "$UI_BODY" | grep -q "<div id=\"root\">"; then
  echo "冒烟失败：launcher UI 服务断言未通过"; cat "$SMOKE_LOG" 2>/dev/null | head -10; kill "$SMOKE_PID" 2>/dev/null || true; rm -rf "$SMOKE_HOME"; exit 1
fi
echo "  UI 服务断言 OK"
kill "$SMOKE_PID" 2>/dev/null || true
# 必须**等进程真正退出**再删目录：
#   kill 是异步的；刚启动的 daemon 及其子进程可能仍在写 $SMOKE_HOME，
#   此时 rm -rf 会因遍历期间目录被新建文件而报 "Directory not empty" 并以非零退出；
#   在 set -e 下直接中止整个构建（冒烟断言其实已通过，却报发布失败）。
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$SMOKE_PID" 2>/dev/null || break
  sleep 0.3
done
kill -9 "$SMOKE_PID" 2>/dev/null || true
# 清理本身绝不允许影响构建结果
rm -rf "$SMOKE_HOME" 2>/dev/null || true

echo "[5/6] 产物清单"
for d in "${DIRS[@]}"; do ls -lh "$d/core.cjs" | awk '{printf "  %-46s %s\n", $9, $5}'; done
echo "[6/6] 完成：$OUT/（launcher 形态，Node >=18 依赖）"
