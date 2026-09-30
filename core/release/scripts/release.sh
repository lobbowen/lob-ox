#!/usr/bin/env bash
# 守卫源码打包出口：仅产出「全源码 tar.gz」供人工分发/自用。
#   release/scripts/release.sh [version]
#  - version 默认取 package.json。
# 产物：dist/release/dsh-supervisor-<ver>.tar.gz（bin/src/ui，零依赖源码包）。
#
#  发布通道收敛：本脚本不再是自更新通道——
#   不再生成 dist/release/manifest.json（曾产出 url=127.0.0.1:39240 污染 manifest）。
#   内核发布唯一通道 = build:launcher Node launcher + scripts/publish-core.sh npm 平台子包；
#   守卫自身更新走同一 npm 执行器（DistributionManager.runNpmInstall + 平台子包）。
#   本脚本仅保留为「源码打包」出口（人工审计/分发自用），产出自检照旧。
# 双仓隔离：壳源码不在本仓（壳是独立仓），包内只含内核资产。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="${1:-$(node -p "require('./package.json').version")}"
DIST="dist/release"
PAK="dsh-supervisor-$VER"
DIR="$DIST/$PAK"

rm -rf "$DIR"; mkdir -p "$DIR"
# 内核资产（双仓拆分后本仓无 src-tauri；壳图标不再随内核源码包分发——内核包用 ui-react 面板）。
for d in bin src; do [ -e "$ROOT/$d" ] && cp -r "$ROOT/$d" "$DIR/"; done
# 清理：不再拷 ROOT/config.json（含构建机绝对路径的死双源）——守卫运行读内嵌 DEFAULT_CONFIG
#   或用户配置 <产品状态根>/supervisor/config.json
cp "$ROOT/package.json" "$DIR/"

# 新 React UI（supervisor 控制面板）：统一构建入口 release/scripts/build-ui.sh（构建 -> ui/dist -> ui-react 镜像）。
# 源码缺失且无镜像时才告警（release.sh 仍允许产出无 UI 的源码包，发布校验见下方）。
if [ -d "$ROOT/ui" ] && [ -f "$ROOT/ui/package.json" ]; then
  bash "$ROOT/release/scripts/build-ui.sh"
elif [ ! -f "$ROOT/ui-react/supervisor.html" ]; then
  echo "[ui] 警告：未找到前端源码($ROOT/ui) 且 ui-react 产物缺失，发布包将无新 UI"
fi
if [ -d "$ROOT/ui-react" ]; then
  cp -r "$ROOT/ui-react" "$DIR/ui-react"
  # 产物自检：确认新 UI 入口存在
  [ -f "$DIR/ui-react/supervisor.html" ] || { echo "发布中止：ui-react 缺少 supervisor.html"; exit 1; }
fi

# 产物自检：全部 JS 语法冒烟（含 bin 入口脚本，排除 vendor）
# 复：find 默认换行输出配 read -d ""（NUL 分隔）会让循环体永不执行（门禁静默失效）；
# 改用 find -print0（NUL 分隔）配 read -d ""，并用括号限定 -o 优先级只收集 .js 与 bin 入口。
fails=0
while IFS= read -r -d "" f; do
  case "$f" in *vendor*) continue;; esac
  node --check "$f" >/dev/null 2>&1 || { echo "SYNTAX FAIL: $f"; fails=1; }
done < <(find "$DIR/bin" "$DIR/src" \( -type f -name "*.js" -o -type f -path "$DIR/bin/dsh-supervisor" \) -print0 | sort -z) || true
[ "$fails" -eq 0 ] || { echo "发布中止：产物语法自检失败"; exit 1; }

TAR="$DIST/$PAK.tar.gz"
tar -czf "$TAR" -C "$DIST" "$PAK"
SHA=$(sha256sum "$TAR" | awk '{print $1}')
echo "=== 源码打包产物就绪 ==="
echo "tar:      $TAR  ($(du -h "$TAR" | awk '{print $1}'))"
echo "sha256:   $SHA"
echo
echo "说明（D1 定案）：本产物为源码打包，非发布通道。内核发布通道只有 CI："
echo "  推 tag（内核命名空间 = core-<内核版本>，见 release/scripts/bump.sh）触发 CI 的 core.yml 矩阵 —— 四平台各自 build:launcher 并在 token-scoped 步骤 publish:core --publish"
echo "  （launcher 构建与子包发布在本机一律被拒；原硬标准 RELEASE-STANDARD.md 已归档至 C:\work\_md_backup）"
