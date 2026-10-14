#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# 唯一质量判据 = CI 构建结果（见 .github/workflows/core.yml / shell.yml）。
# 本脚本只做构建与发布，不做测试、不做静态自检、不做工程设计类门禁。
# 工程收尾时跑一次即可（本地不跑测试、不跑门禁）。

PUBLISH=0
PUBLISH_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    --publish-only) PUBLISH=1; PUBLISH_ONLY=1 ;;
    *) echo "未知参数: $1（支持 --publish / --publish-only）"; exit 2 ;;
  esac
  shift
done

if [ "$PUBLISH" = 1 ] && [ "${GITHUB_ACTIONS:-}" != 'true' ]; then
  echo '拒绝：真发布（--publish）只允许在 GitHub CI 内运行（GITHUB_ACTIONS=true）。' >&2
  exit 2
fi

if [ "$PUBLISH_ONLY" = 1 ]; then
  node release/scripts/verify-versions.js --core
  echo "=== publish-only：构建阶段已由 CI 不带令牌的前一步完成 ==="
  echo "=== 真发布内核子包（认证由 publish-core.sh 单源处理）==="
  export DSH_PUBLISH_REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
  npm run publish:core -- --publish
  echo "=== 内核发布产线完成 ==="
  exit 0
fi

echo "=== [0/3] 运行时契约自检（engines.node 必须与 runtime.minNode 单源同口径）==="
node release/scripts/verify-versions.js --core

echo "=== [1/3] 构建 UI 产物（npm ci 可复现安装 + npm run build）==="
if [ -f ui/package.json ]; then
  echo "[ui] 安装前端依赖（npm ci，可复现构建）..."
  (cd ui && npm ci) || { echo "[ui] ERROR: 前端依赖安装失败（npm ci）"; exit 1; }
  DSH_UI_SKIP_INSTALL=1 bash release/scripts/build-ui.sh
else
  bash release/scripts/build-ui.sh
fi

echo "=== [2/3] 构建内核 launcher（build:launcher）==="
npm run build:launcher --

echo "=== [3/3] 内核子包 dry-run（组装 + 打包审计，不发）==="
npm run publish:core -s --
ls -lh dist/npm/

if [ "$PUBLISH" = 1 ]; then
  echo "=== 真发布内核子包 ==="
  export DSH_PUBLISH_REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
  npm run publish:core -- --publish
fi

echo "=== 内核发布产线完成 ==="
