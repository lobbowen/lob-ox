#!/usr/bin/env bash
# 内核发布产线（CI 核心逻辑单源）—— .github/workflows/build.yml 的四平台 build 矩阵调用（test job 自跑等价步骤）。
# 硬标准：**所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物。**
# 用法: release/scripts/ci-core.sh [--publish] [--publish-only] [--all-platforms]
#   - 无 --publish      = 只验证（verify:versions -> 前端 verify -> npm test -> build:launcher
#                         -> 产物 glibc 基座门禁（Linux - 条件执行）-> 子包 dry-run）
#   - --publish         = 验证通过后真发布**本平台**子包 -> 官方 registry（**仅 CI 内**；GITHUB_ACTIONS 守卫）
#   - --publish-only    = 只跑 [5/5] 真发布，跳过全部验证（**仅 CI 内**；A3-a：CI 拆两步后，
#                         验证已在不带令牌的步骤跑完，本模式让 NPM_TOKEN 只存在于发布进程树；
#                         依赖同 workspace 已产出的 dist/launcher —— 缺产物时 publish-core.sh 拒绝）
#   - --all-platforms   = 一律拒绝（已废弃；四平台由 CI 各 runner 各自产出）
# 版本：从仓库根 package.json 单源注入；launcher 自报版本错配即拒绝（publish-core.sh 内置强制）。
# 形态：全平台弃 SEA（macOS Node SEA 注入后段错误），统一 Node launcher。
#
# 认证：本脚本**不再改动用户全局 npm 配置**。
#   原实现执行 `npm config set registry` + `npm config set //registry.npmjs.org/:_authToken`
#   ——前者把开发机的默认 registry 永久改成官方源（用户平时用镜像源），
#   后者把 token **明文写入 ~/.npmrc**。现改为：有 NPM_TOKEN 就写进**临时 userconfig**
#   并以 NPM_CONFIG_USERCONFIG 传给子进程（进程结束即删）；无 token 则沿用既有登录态。
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

# A3-a：CI 把「验证」与「发布」拆成两个步骤，NPM_TOKEN 只挂在发布步。
# 本模式直接跳到 [5/5]：前置产物由同 workspace 的验证步产出（publish-core.sh 的产物
# 存在性 + 版本自洽冒烟检查就是闸，缺产物/错配即拒绝，不会带病发布）。
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
#  复：前端门禁此前**从未在任何路径上执行** ——
#   `ui/package.json` 有 typecheck/lint/test 与 3 个 .test.ts（15 个用例），
#   但 `build-ui.sh` **只构建不测试** —— 历史上曾有一处不存在于任何脚本的「[3/7] UI 门禁」
#   被写进 CI 注释（编排器 release-core.sh 早已只有 [1/5]–[3/5]，现已删除）。
#   现由此处在**构建之前**跑完整 verify：语法/类型/测试不过就不该产出镜像。
#
# 顺序理由：`npm run verify` 内部已含 build（typecheck -> lint -> test -> build），
#   故它成功即等价于原 build-ui 的效果；但 build-ui 还负责 `ui-react/` 镜像镜像化，
#   故 verify 之后仍调用 build-ui。
#
#  复（P1）：**必须先装依赖再跑门禁**。
#   缺陷：原顺序是「先 verify、后 build-ui」，而 `npm ci` 在 build-ui 里 ——
#     CI 是**全新检出**（无 ui/node_modules）-> tsc 对每个依赖报 TS2307
#     （react / sonner / lucide-react / vitest …）->「前端门禁未通过」。
#     本地一直绿，只是因为本机有现成的 node_modules。
#     且注释所称「build-ui 内部在已装依赖时跳过 npm ci」**不成立** ——
#     它只有设了 DSH_UI_SKIP_INSTALL=1 才跳过，故这里显式设置以避免重复安装。
#   为什么长期不可见：本段是 （443eb70）才加进 ci-core 的，
#     而上次 tag 构建是 09-11（v0.1.5-BETA.1）-> **本段从未在 CI 运行过**；
#     首次运行（v0.1.5-BETA.2 的 tag run）即四平台同时红，日志里的 TS2307 成片。
#   顺序保持原意（门禁不过就不该产出镜像）：装依赖 -> 门禁 -> 镜像。
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
#  复（跨平台假覆盖）：本脚本原先跑**完整** npm test，而 build 矩阵有四条腿 ——
#   于是同一条链（绝大多数条目与宿主无关）在每个 runner 上各跑一遍，每次 push 共 5 遍，
#   真正的跨平台证据（OS 相关行为）却没有专门通道。现在按 test/manifest.js 的分层跑：
#   矩阵腿只跑 L2（真 spawn 进程 / 跑 bash、pkill、systemctl / 读 /proc / 断言权限位的那批），
#   L1 由 test job 在 ubuntu 上跑一遍即判。
#   ⚠️ 2026-10-01：原先"分层与缺口台账由 test-chain-completeness C-g/C-h 执法"已随该门禁整体拆除
#   （移至 C:\work\_gate_backup）⇒ **现在分层标注只是选跑范围，没有机制核对它是否被遵守**。
#  复（P1）：**看护 E2E 需要图形会话**（保留原修法）。
#   shell-watchdog-e2e 验证「壳缺失 -> 真的被拉起」，看护拉起 GUI 壳前先判图形会话
#   （src/platform/os/desktop.js::sessionAvailable —— 刻意设计，防无显示时重启风暴）。
#   linux 需要 Xvfb 提供 DISPLAY；darwin/win32 判定恒为真，故「有 xvfb-run 就用、没有就直跑」。
if command -v xvfb-run >/dev/null 2>&1; then
  echo "[test] 经 xvfb-run 提供图形会话（看护 E2E 需要）..."
  xvfb-run -a npm run test:os-behavior
else
  npm run test:os-behavior
fi

echo "=== [3/5] 构建内核 launcher（build:launcher：esbuild bundle + node 启动脚本，全平台统一） ==="
npm run build:launcher --

echo "=== [3.5/5] 产物 glibc 基座门禁（仅 Linux · 条件执行） ==="
# E-2：build.yml 的矩阵注释长期声称「构建后由 ci-core.sh 的
#   『glibc 基座门禁（Linux）』步骤校验产物」，而本脚本**从未有该步**（grep glibc = 0 命中）——
#   「文档化门禁 != 实际执行」。现在把它真正接上，并按产物形态条件执行：
#   当前形态是纯 JS launcher，Linux 产物里**没有 ELF**，
#   故本步如实打印「无对象可检」；一旦重新引入原生二进制（SEA / pkg / 任何 .node/.so/ELF），
#   同一分支即自动执法（GLIBC_* 符号高于 2.35 就 fail），不必再改产线。
#   根因不变：glibc 前向兼容 —— 在 24.04（2.39）基座构建的 ELF 装不到 22.04（2.35）/ Debian 12。
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
