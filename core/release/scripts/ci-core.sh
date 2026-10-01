#!/usr/bin/env bash
# 内核发布产线（CI 核心逻辑单源）—— .github/workflows/core.yml 的四平台 build 矩阵调用（test job 自跑等价步骤）。
# 硬标准：**所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物。**
# 用法: release/scripts/ci-core.sh [--publish] [--publish-only] [--all-platforms]
#   - 无 --publish      = 只验证（verify:versions -> 前端 verify -> npm test -> build:launcher
#                         -> 产物 glibc 基座门禁（Linux - 条件执行）-> 子包 dry-run）
#   - --publish         = 验证通过后真发布**本平台**子包 -> 官方 registry（**仅 CI 内**；GITHUB_ACTIONS 守卫）
#   - --publish-only    = 只跑 [5/5] 真发布，跳过全部验证（**仅 CI 内**；让 NPM_TOKEN 只存在于发布进程树；
#                         依赖同 workspace 已产出的 dist/launcher —— 缺产物时 publish-core.sh 拒绝）
#   - --all-platforms   = 一律拒绝（本地不得有全平台构建/发布路径）
# 版本：从仓库根 package.json 单源注入；launcher 自报版本错配即拒绝（publish-core.sh 内置强制）。
# 形态：全平台统一 Node launcher（不用 Node SEA：macOS 注入后段错误）。
# 认证：本脚本不改动用户全局 npm 配置。有 NPM_TOKEN 就写进**临时 userconfig** 并以
#   NPM_CONFIG_USERCONFIG 传给子进程（进程结束即删）；无 token 则沿用既有登录态。
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
      # 硬标准：本地不得有全平台构建/发布路径。
      echo '拒绝：--all-platforms 已废弃（2026-09-13 硬标准：构建与发布均经 GitHub CI）。' >&2
      exit 2 ;;
    *) echo "未知参数: $1（支持 --publish / --publish-only / --all-platforms）"; exit 2 ;;
  esac
  shift
done

# 硬标准：真发布只允许在 GitHub CI 内（单平台也不例外）。
if [ "$PUBLISH" = 1 ] && [ "${GITHUB_ACTIONS:-}" != 'true' ]; then
  echo '拒绝：真发布（--publish）只允许在 GitHub CI 内运行（GITHUB_ACTIONS=true）。' >&2
  exit 2
fi

# publish-only 直接跳到 [5/5]：前置产物由同 workspace 的验证步产出，
# publish-core.sh 的产物存在性 + 版本自洽冒烟检查即闸，缺产物/错配即拒绝，不会带病发布。
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
# 前端门禁必须跑在**构建之前**：typecheck/lint/test 不过就不该产出镜像。
# 且必须先装依赖再跑门禁 —— CI 是**全新检出**（无 ui/node_modules），
#   否则 tsc 对每个依赖报 TS2307（react / sonner / lucide-react / vitest …）。
# `npm run verify` 内部已含 build（typecheck -> lint -> test -> build），
#   但 ui-react/ 镜像化仍由 build-ui.sh 负责，故 verify 之后仍调用它。
if [ -f ui/package.json ]; then
  echo "[ui] 安装前端依赖（npm ci，可复现构建）..."
  (cd ui && npm ci) || { echo "[ui] ERROR: 前端依赖安装失败（npm ci）"; exit 1; }
  echo "[ui] 前端门禁（verify = typecheck + lint + test + build）..."
  (cd ui && npm run verify) || { echo "[ui] ERROR: 前端门禁未通过（typecheck/lint/test/build）"; exit 1; }
  # 依赖已装好 -> 跳过 build-ui 自己的 npm ci，避免重复安装。
  DSH_UI_SKIP_INSTALL=1 bash release/scripts/build-ui.sh
else
  bash release/scripts/build-ui.sh
fi

echo "=== [2/5] 本宿主相关的内核回归（仅 L2 分层，全链由 test job 跑一遍） ==="
# 按 test/manifest.js 分层跑：矩阵腿只跑 L2（真正跨平台的那批：spawn 进程 / 跑 bash、pkill、
#   systemctl / 读 /proc / 断言权限位），L1 由 test job 在 ubuntu 上跑一遍即判，
#   同一链不在每个 runner 上重复。
# 看护 E2E（壳缺失 -> 真的被拉起）需要图形会话：拉起 GUI 壳前先判图形会话
#   （src/platform/os/desktop.js::sessionAvailable，防无显示时重启风暴）；
#   linux 需 Xvfb 提供 DISPLAY，darwin/win32 判定恒为真，故「有 xvfb-run 就用、没有就直跑」。
if command -v xvfb-run >/dev/null 2>&1; then
  echo "[test] 经 xvfb-run 提供图形会话（看护 E2E 需要）..."
  xvfb-run -a npm run test:os-behavior
else
  npm run test:os-behavior
fi

echo "=== [3/5] 构建内核 launcher（build:launcher：esbuild bundle + node 启动脚本，全平台统一） ==="
npm run build:launcher --

echo "=== [3.5/5] 产物 glibc 基座门禁（仅 Linux · 条件执行） ==="
# 逐 Linux ELF 产物校验 glibc 基座：当前 launcher 是纯 JS，dist/ 下没有 ELF，
#   故本步如实打印「无对象可检」；一旦产物里出现原生二进制（.node/.so/ELF），
#   同一分支即按 GLIBC_2.35 上限自动执法，不必再改产线。
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
