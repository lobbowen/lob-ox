#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="${1:-$(node -p "require('./package.json').version")}"
DIST="dist/release"
PAK="lobox-$VER"
DIR="$DIST/$PAK"

rm -rf "$DIR"; mkdir -p "$DIR"
for d in bin src; do [ -e "$ROOT/$d" ] && cp -r "$ROOT/$d" "$DIR/"; done
# 不拷 ROOT/config.json（含构建机绝对路径的死双源）；守卫运行读内嵌 DEFAULT_CONFIG
#   或用户配置 <产品状态根>/supervisor/config.json
cp "$ROOT/package.json" "$DIR/"

# 统一构建入口 release/scripts/build-ui.sh（构建 -> ui/dist -> ui-react 镜像）。
if [ -d "$ROOT/ui" ] && [ -f "$ROOT/ui/package.json" ]; then
  bash "$ROOT/release/scripts/build-ui.sh"
elif [ ! -f "$ROOT/ui-react/supervisor.html" ]; then
  echo "[ui] 警告：未找到前端源码($ROOT/ui) 且 ui-react 产物缺失，发布包将无新 UI"
fi
if [ -d "$ROOT/ui-react" ]; then
  cp -r "$ROOT/ui-react" "$DIR/ui-react"
  [ -f "$DIR/ui-react/supervisor.html" ] || { echo "发布中止：ui-react 缺少 supervisor.html"; exit 1; }
fi

# find 必须用 -print0 配 read -d ""（默认换行输出会让循环体永不执行），
# 并用括号限定 -o 优先级，只收集 .js 与 bin 入口。
fails=0
while IFS= read -r -d "" f; do
  case "$f" in *vendor*) continue;; esac
  node --check "$f" >/dev/null 2>&1 || { echo "SYNTAX FAIL: $f"; fails=1; }
done < <(find "$DIR/bin" "$DIR/src" \( -type f -name "*.js" -o -type f -path "$DIR/bin/lobox" \) -print0 | sort -z) || true
[ "$fails" -eq 0 ] || { echo "发布中止：产物语法自检失败"; exit 1; }

TAR="$DIST/$PAK.tar.gz"
tar -czf "$TAR" -C "$DIST" "$PAK"
SHA=$(sha256sum "$TAR" | awk '{print $1}')
echo "=== 源码打包产物就绪 ==="
echo "tar:      $TAR  ($(du -h "$TAR" | awk '{print $1}'))"
echo "sha256:   $SHA"
echo
echo "说明：本产物为源码打包，非发布通道。内核发布通道只有 CI："
echo "  推 tag（内核命名空间 = core-<内核版本>，见 release/scripts/bump.sh）触发 CI 的 core.yml 矩阵 —— 四平台各自 build:launcher 并在 token-scoped 步骤 publish:core --publish"
echo "  （launcher 构建与子包发布在本机一律被拒）"
