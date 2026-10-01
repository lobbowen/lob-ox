#!/usr/bin/env bash
# 由 .github/workflows/core.yml 的四平台 build 矩阵调用。
# 硬标准：构建与发布均必须经 GitHub CI；本地不得产生发布产物。
# 不用 Node SEA：macOS 注入后段错误（故全平台统一 Node launcher）。
# 认证不变式：不改动用户全局 npm 配置；NPM_TOKEN 只写进临时 userconfig（进程结束即删）并仅经 NPM_CONFIG_USERCONFIG 传给子进程。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PUBLISH=0
PUBLISH_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) PUBLISH=1 ;;
    --publish-only) PUBLISH=1; PUBLISH_ONLY=1 ;;
    --all-platforms)
      echo '拒绝：--all-platforms 不再接受：本产线一律四平台构建，且构建与发布均经 GitHub CI。' >&2
      exit 2 ;;
    *) echo "未知参数: $1（支持 --publish / --publish-only / --all-platforms）"; exit 2 ;;
  esac
  shift
done

if [ "$PUBLISH" = 1 ] && [ "${GITHUB_ACTIONS:-}" != 'true' ]; then
  echo '拒绝：真发布（--publish）只允许在 GitHub CI 内运行（GITHUB_ACTIONS=true）。' >&2
  exit 2
fi

if [ "$PUBLISH_ONLY" = 1 ]; then
  echo "=== [0/5..4/5] （publish-only：验证已由 CI 不带令牌的前一步完成） ==="
  echo "=== [5/5] 真发布内核子包（官方 registry；认证由 publish-core.sh 单源处理） ==="
  export DSH_PUBLISH_REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
  npm run publish:core -- --publish
  echo "=== 内核发布产线完成 ==="
  exit 0
fi

echo "=== [0/5] 版本自洽校验（内核 package.json 单源；壳版本互锁已随壳仓剥离） ==="
npm run verify:versions

echo "=== [1/5] 前端门禁（typecheck + lint + vitest）+ 构建 UI 产物 ==="
# CI 为全新检出（无 ui/node_modules）：须先 npm ci，否则 tsc 对每个依赖报 TS2307。
if [ -f ui/package.json ]; then
  echo "[ui] 安装前端依赖（npm ci，可复现构建）..."
  (cd ui && npm ci) || { echo "[ui] ERROR: 前端依赖安装失败（npm ci）"; exit 1; }
  echo "[ui] 前端门禁（verify = typecheck + lint + test + build）..."
  (cd ui && npm run verify) || { echo "[ui] ERROR: 前端门禁未通过（typecheck/lint/test/build）"; exit 1; }
  DSH_UI_SKIP_INSTALL=1 bash release/scripts/build-ui.sh
else
  bash release/scripts/build-ui.sh
fi

echo "=== [2/5] 本宿主相关的内核回归（仅 L2 分层，全链由 test job 跑一遍） ==="
# 看护 E2E 需图形会话（src/platform/os/desktop.js::sessionAvailable）：linux 需 xvfb-run 供 DISPLAY，darwin/win32 恒有。
if command -v xvfb-run >/dev/null 2>&1; then
  echo "[test] 经 xvfb-run 提供图形会话（看护 E2E 需要）..."
  xvfb-run -a npm run test:os-behavior
else
  npm run test:os-behavior
fi

echo "=== [3/5] 构建内核 launcher（build:launcher：esbuild bundle + node 启动脚本，全平台统一） ==="
npm run build:launcher --

echo "=== [3.5/5] 产物 glibc 基座门禁（仅 Linux · 条件执行） ==="
if [ "$(uname -s)" = 'Linux' ]; then
  is_elf() { [ "$(od -An -N4 -tx1 "$1" 2>/dev/null | tr -d ' \n')" = '7f454c46' ]; }
  elf_count=0
  while IFS= read -r -d '' f; do
    if is_elf "$f"; then
      elf_count=$((elf_count + 1))
      bash ci/check-glibc.sh "$f" 2.35
    fi
  done < <(find dist -type f -print0 2>/dev/null || true)
  if [ "$elf_count" = 0 ]; then
    echo "  [glibc] dist/ 下无 ELF 产物（launcher 为纯 JS 形态）→ 本步无对象可检（如实留痕，不假装通过）"
  else
    echo "  [glibc] 已校验 $elf_count 个 ELF 产物 ≤ GLIBC_2.35"
  fi
else
  echo "  [glibc] 非 Linux 宿主，跳过（glibc 是 Linux 专有概念）"
fi

echo "=== [4/5] 内核子包 dry-run（组装 + 打包审计，不发） ==="
npm run publish:core -s --
ls -lh dist/npm/

if [ "$PUBLISH" = 1 ]; then
  echo "=== [5/5] 真发布内核子包（官方 registry；认证由 publish-core.sh 单源处理） ==="
  export DSH_PUBLISH_REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
  npm run publish:core -- --publish
else
  echo "=== [5/5] （跳过真发布：加 --publish 即发官方 registry） ==="
fi

echo "=== 内核发布产线完成 ==="
