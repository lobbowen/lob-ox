#!/usr/bin/env bash
# 内核 npm 子包发布（构建物 = Node launcher）：只在 GitHub CI 内运行，本机不得执行、不得产出发布产物（本机自查上限是纯静态检查）。
# 版本从仓库根 package.json 单源注入（禁手写，裸版本无 v 前缀）；发布前强制校验 launcher self-check 自报版本 = 单源，产物命名 lobox-<ver>-<plat>-<arch>。
# ── 发布前必须知道的三条（现状 + 操作要求） ────────────────────────────────
# ① 版本线重置后内核只能经 rollback dist-tag 投递：只有通道的 rollback 分支才会对「低于当前」的目标动手
#    （shell/src-tauri/src/core.rs 的 core 定位/更新逻辑）⇒ 防降级下限必须 ≤ 目标版本（现为 0.0.0，见 core/src/platform/distribution/release.js）。
# ② 0.0.1 / 1.0.0 无预发布后缀 ⇒ dist-tag 打 latest；而 reconcile_latest_tag 只升不降
#    ⇒ 发布前先人工核对 `npm view <包> dist-tags`（首次发布新包名时无此风险）。
# ③ 壳的存量机器不会自动降级：tauri-plugin-updater 的判据是 release.version > current_version，未注入 version_comparator
#    ⇒ 从更高版本线（如 1.2.x）切到重置后的 1.0.0 需人工分发一次。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="$(node -p "require('./package.json').version")"

PUBLISH=0
SCOPE="$(node -p "try{const p=require('./package.json');(p.npmPublish&&p.npmPublish.scope)||''}catch(e){''}")"
MAIN_LICENSE="$(node -p "require('./package.json').license")"
# repository.url 必须与 provenance 签名的仓库地址一致，否则 registry 校验 E422 拒发。
MAIN_REPO="$(node -p "try{const p=require('./package.json');(p.repository&&p.repository.url)||''}catch(e){''}")"
[ -n "$SCOPE" ] || SCOPE="${DSH_CORE_SCOPE:-}"
[ -n "$SCOPE" ] || SCOPE="@lob-ox"
while [ $# -gt 0 ]; do case "$1" in
  --publish) PUBLISH=1 ;;
  --all-platforms)
    echo '拒绝：--all-platforms 不再接受：本产线一律四平台构建。' >&2
    echo '  四平台子包由 CI 各平台 runner 各自发布（tag 触发）；本地不得全平台发布。' >&2
    exit 2 ;;
  --dry-run) PUBLISH=0 ;;
  --scope) SCOPE="${2:?--scope 需要值}"; shift ;;
  --scope=*) SCOPE="${1#*=}" ;;
  *) echo "未知参数: $1（支持 --publish / --dry-run / --all-platforms / --scope <val>）"; exit 2 ;;
esac; shift; done

if [ "$PUBLISH" = 1 ] && [ "${GITHUB_ACTIONS:-}" != 'true' ]; then
  echo '拒绝：真发布（--publish）只允许在 GitHub CI 内运行（GITHUB_ACTIONS=true）。' >&2
  echo '  硬标准：所有平台构建与发布必须经 GitHub CI 完成；本地不得产生发布产物。' >&2
  echo '  本地只允许 dry-run（不带 --publish）。' >&2
  exit 2
fi

PLAT="$(node -p "process.platform")"
ARCH="$(node -p "process.arch")"
# GitHub macos-14 现为 arm64（launcher 架构无关）：用 DSH_PLATFORM_OVERRIDE/DSH_ARCH_OVERRIDE 在任意 runner 产指定平台包。
PLAT="${DSH_PLATFORM_OVERRIDE:-$PLAT}"
ARCH="${DSH_ARCH_OVERRIDE:-$ARCH}"
case "$PLAT" in linux) OS_TAG=linux;; darwin) OS_TAG=darwin;; win32) OS_TAG=win;;
  *) echo "不支持的平台: $PLAT"; exit 1;; esac
case "$ARCH" in x64|arm64) ;; *) echo "不支持的架构: $ARCH （子包仅 x64/arm64）"; exit 1;; esac
PKG_NAME="$SCOPE/core-$OS_TAG-$ARCH"
SRC_DIR="dist/launcher/lobox-$VER-$PLAT-$ARCH"
[ -d "$SRC_DIR" ] || {
  echo "缺少构建产物: $SRC_DIR"
  echo "  同一 run 内的 launcher 构建入口：npm run build:launcher（仅 CI 内，按 DSH_*_OVERRIDE 定平台）"
  exit 1
}
[ -f "$SRC_DIR/bin/lobox" ] || { echo "产物缺 bin/lobox: $SRC_DIR"; exit 1; }
[ -f "$SRC_DIR/core.cjs" ] || { echo "产物缺 core.cjs: $SRC_DIR"; exit 1; }
# launcher 形态：node 启动脚本（win 亦无 .exe——由 npm bin shim 生成）

GV="$(node "$SRC_DIR/bin/lobox" self-check | sed -n 's/^guardVersion=//p' | tr -d '\r')"
[ "$GV" = "$VER" ] || { echo "版本错配：launcher 自报 $GV ≠ 单源 $VER （禁止发布）"; exit 1; }
echo "== 冒烟通过: guardVersion=$GV （= 单源） =="

STAGE="dist/npm/$PKG_NAME"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -r "$SRC_DIR/bin" "$STAGE/bin"
cp "$SRC_DIR/core.cjs" "$STAGE/core.cjs"
if [ -d "$SRC_DIR/ui-react" ]; then
  cp -r "$SRC_DIR/ui-react" "$STAGE/ui-react"
  [ -f "$STAGE/ui-react/supervisor.html" ] || { echo "错误：ui-react 缺 supervisor.html"; exit 1; }
else
  echo "警告：launcher 产物缺 ui-react"
fi
# 不得把 shell 变量拼进 node -e 源码：package.json 字段含 ' 即可越出字符串字面量改写整段（CI 内执行 = 供应链注入面）；统一经 env 导出、JS 只读 process.env。
export GEN_PKG_NAME="$PKG_NAME" GEN_VER="$VER" GEN_LICENSE="$MAIN_LICENSE" GEN_REPO="$MAIN_REPO" GEN_STAGE="$STAGE" GEN_PLAT="$PLAT" GEN_ARCH="$ARCH" GEN_OSTAG="$OS_TAG"
node -e 'const fs=require("fs"),e=process.env;const o={name:e.GEN_PKG_NAME,version:e.GEN_VER,description:"DSH lifecycle guard core (Node launcher) for "+e.GEN_OSTAG+"-"+e.GEN_ARCH+" — requires Node >=18.",license:e.GEN_LICENSE,repository:{type:"git",url:e.GEN_REPO},os:[e.GEN_PLAT],cpu:[e.GEN_ARCH],bin:{"lobox":"bin/lobox"},files:["bin","core.cjs","ui-react","README.md"],keywords:["lobox","guard","launcher","core"]};fs.writeFileSync(e.GEN_STAGE+"/package.json",JSON.stringify(o,null,2)+String.fromCharCode(10))'
cat > "$STAGE/README.md" <<EOF
# $PKG_NAME

DSH lifecycle guard core — Node launcher 形态（esbuild bundle + node 启动脚本，需 Node ≥18）。
本包仅面向 $OS_TAG-$ARCH （npm os/cpu 平台过滤）。

\`\`\`bash
# 当前通道版本（latest = 我们发布的最新版，档位可能是 RC 也可能是 BETA）
npm i -g $PKG_NAME
# 显式按档位安装（beta=最新测试版 / rc=最新正式版别名）
npm i -g $PKG_NAME@beta
# 显式指定版本（**仅排障/人工分发**；日常升级不要绕过标签）
npm i -g $PKG_NAME@<version>

lobox self-check   # guardVersion / node / platform 三段自检
\`\`\`

> 本包由桌面壳（lobox 桌面壳）与内核自身按**发布通道契约**自动安装与升级：
> 选版一律走 \`rollback → canary → dist-tags.latest → versions 最高兜底 → 明确失败\`
> （**latest 优先**，绝不「取 registry 全量最高」——那会绕过通道控制；latest 缺失时的兜底步
> 还排除 \`-BETA.\` 测试版）。选定版本后按 \`$PKG_NAME@<version>\` 显式安装。
> latest 由发布脚本每次发布后核验并回补（只升不降），因此**它才是自动升级的目标通道**；
> 要退出升级请走人工分发（显式版本），不要靠陈旧 latest —— 那会让安全修复不可达。
> 算法单源见内核仓 RELEASE-CHANNEL-CONTRACT.md §3 + \`pickReleaseVersion\`。
> 手工安装仅供排障。
EOF
echo "== 子包已组装: $STAGE/"
ls -lh "$STAGE/bin/" | tail -1

cd "$STAGE"
# dist-tag 只有两档：版本串含预发布后缀 `-` 一律显式挂 beta，纯 x.y.z 才挂 latest（不逐档枚举后缀，也不依赖 npm 默认 tag 行为）。
# latest 发布后必须回补且只升不降（客户端选版链只读 latest，兜底步刻意排除 -BETA.）；rollback / canary 刻意不由本脚本设置，见 RELEASE-CHANNEL-CONTRACT.md §3。
DIST_TAG=""
case "$VER" in
  *-RC.*) DIST_TAG="--tag latest" ;;
  *-*)    DIST_TAG="--tag beta" ;;
  *)      DIST_TAG="--tag latest" ;;
esac
# 发布必须官方源：本机默认 npmmirror 只读消费不适配发布认证。
# 认证解析单源在 release/scripts/_npm-auth.sh（本脚本与 configure-credentials.sh 共用）：DSH_NPMRC -> NPM_CONFIG_USERCONFIG -> NPM_TOKEN -> 真实 home ~/.npmrc -> 沙箱 $HOME/.npmrc。
# 「真实 home」经 getent/dscl 解析、不受沙箱 $HOME 覆盖影响，否则会出现「A 沙箱能发版、B 沙箱 ENEEDAUTH」。
REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
# shellcheck source=./_npm-auth.sh
. "$ROOT/release/scripts/_npm-auth.sh"
trap 'dsh_npm_auth_cleanup' EXIT
if dsh_npm_auth_setup; then
  echo "== 认证：$(dsh_npm_auth_describe) =="
else
  if [ "$PUBLISH" = 1 ]; then
    echo "❌ 未找到任何 npm 发布认证（真发布必需）。任选其一后重试："
    echo "   a) bash release/scripts/configure-credentials.sh --npm   # NPM_TOKEN → 真实 home ~/.npmrc(0600)，一次性"
    echo "   b) export NPM_TOKEN=<automation token>                    # 仅本次会话，不落盘"
    echo "   c) npm login --registry=https://registry.npmjs.org/"
    exit 1
  fi
  echo "== 认证：无（dry-run 不校验认证；真发布需先配置） =="
fi

# latest 只升不降：把 latest 往回拉属「紧急回退」语义，是人工运维，脚本绝不自动做；比较用内核 semverCompare 单源（src/shared/version.js）。
# 失败必须非零退出：「包发出去了但通道没对齐」正是本步骤要消灭的状态。
reconcile_latest_tag() {
  local cur promote out
  cur="$(npm view "$PKG_NAME" dist-tags.latest --json --registry="$REGISTRY" 2>/dev/null \
        | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{let v="";try{v=JSON.parse(b)}catch(e){}process.stdout.write(typeof v==="string"?v:"")})' || true)"
  cur="${cur//$'\r'/}"
  promote="$(CUR_LATEST="$cur" PUBLISH_VER="$VER" DSH_VERSION_LIB="$ROOT/src/shared/version.js" node -e 'const e=process.env;const {semverCompare}=require(e.DSH_VERSION_LIB);process.stdout.write(!e.CUR_LATEST||semverCompare(e.PUBLISH_VER,e.CUR_LATEST)>0?"yes":"no");')"
  if [ "$promote" != "yes" ]; then
    echo "== 通道核对：latest=${cur} 已不低于本次 ${VER}，不动 =="
    return 0
  fi
  echo "== 通道回补：$PKG_NAME 的 latest（当前=${cur:-无}）-> $VER =="
  if ! out="$(npm dist-tag add "$PKG_NAME@$VER" latest --registry="$REGISTRY" 2>&1)"; then
    echo "❌ latest 回补失败：$PKG_NAME@$VER"
    printf '%s\n' "$out"
    exit 1
  fi
  printf '%s\n' "$out" | tail -1
}

if [ "$PUBLISH" = 1 ]; then
  # npm 不允许覆盖同版本、且没有「只补发缺失平台」入口：同版本已存在时按幂等处理，但先做内容一致性核对（本地 dry-run unpackedSize + 本地真 pack 的 tarball sha1 对远端 dist.unpackedSize / dist.shasum）。
  # 存在性判据是 npm view 退出码：`--json` 对不存在的版本也往 stdout 打 E404 错误对象，以「输出非空」判存在会把首次发布当成已发布；任一要素缺失或不一致 -> 拒绝幂等跳过、非零退出。
  REMOTE_SPEC=''
  if REMOTE_SPEC="$(npm view "$PKG_NAME@$VER" --json --registry="$REGISTRY" 2>/dev/null | tr -d '\r')"; then
    LOCAL_SIZE="$(npm pack --dry-run --json --registry="$REGISTRY" 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(b);console.log((j[0]&&j[0].unpackedSize)||"")}catch(e){console.log("")}})' || true)"
    LOCAL_TGZ="$(npm pack --json --registry="$REGISTRY" 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(b);process.stdout.write((Array.isArray(j)?j[0]:j).filename||"")}catch(e){}})' || true)"
    LOCAL_SHA1=''
    # 摘要用 node 现算而非 GNU sha1sum：macOS runner 没有该二进制，而幂等核对在三平台都要走（部分平台失败的重跑会进这一支）。
    [ -n "$LOCAL_TGZ" ] && [ -f "$LOCAL_TGZ" ] && LOCAL_SHA1="$(TGZ="$LOCAL_TGZ" node -e 'const {createHash}=require("crypto"),{readFileSync}=require("fs");process.stdout.write(createHash("sha1").update(readFileSync(process.env.TGZ)).digest("hex"))' 2>/dev/null || true)"
    REMOTE_SIZE="$(RG="$REMOTE_SPEC" node -e 'try{const j=JSON.parse(process.env.RG);const s=j&&j.dist&&j.dist.unpackedSize;process.stdout.write(s==null?"":String(s))}catch(e){}')"
    REMOTE_SHA="$(RG="$REMOTE_SPEC" node -e 'try{const j=JSON.parse(process.env.RG);process.stdout.write((j&&j.dist&&j.dist.shasum)||"")}catch(e){}')"
    echo "== $PKG_NAME@$VER 已存在于 $REGISTRY → 内容强核对（未通过前绝不按成功跳过）=="
    if [ -z "$REMOTE_SHA" ] || [ -z "$REMOTE_SIZE" ] || [ -z "$LOCAL_SHA1" ] || [ -z "$LOCAL_SIZE" ]; then
      echo "   ❌ 核对要素缺失（远端 size=$REMOTE_SIZE sha=$REMOTE_SHA 本地 size=$LOCAL_SIZE sha=${LOCAL_SHA1}）：无法证明同源，禁止幂等跳过。"; exit 1
    fi
    if [ "$REMOTE_SIZE" != "$LOCAL_SIZE" ] || [ "$REMOTE_SHA" != "$LOCAL_SHA1" ]; then
      echo "   ❌ 内容不一致：unpackedSize 远端=${REMOTE_SIZE} 本地=${LOCAL_SIZE}；shasum 远端=$REMOTE_SHA 本地=$LOCAL_SHA1"
      echo "      同版本远端产物与本地产物不同源 —— 拒绝幂等跳过，请人工裁决（升版本重发或排查构建漂移）。"; exit 1
    fi
    rm -f "$LOCAL_TGZ" 2>/dev/null || true
    echo "   ✅ 体积与 sha1 双项一致，内容可信 → 跳过发布（幂等：视为成功）"
    # 幂等跳过时同样要回补通道：publish 的 --tag 只在首次发布生效，重跑不再写标签，已发布的平台可能正是唯一没对齐 latest 的那次。
    reconcile_latest_tag
    exit 0
  fi
  echo "== 发布 $PKG_NAME@$VER ${DIST_TAG:-（tag=latest）} → $REGISTRY =="
  # --provenance 用 GitHub OIDC 短时令牌向 npm 签发 attestation（npm 侧长期凭证不参与签发，需 build job 已授 id-token: write）。
  # 逃生阀：DSH_NPM_PROVENANCE=0 显式关闭（如无 OIDC 的环境）。
  PUB_PROV=''
  if [ "${DSH_NPM_PROVENANCE:-1}" != '0' ]; then PUB_PROV='--provenance'; fi
  npm publish --access public --registry="$REGISTRY" $DIST_TAG $PUB_PROV
  # npm publish 只接受一个 --tag：RC 正式版发布后补打附加 rc 别名，两档之后统一回补 latest。
  case "$VER" in
    *-RC.*)
      echo "== 补打 rc 标签：$PKG_NAME@$VER =="
      npm dist-tag add "$PKG_NAME@$VER" rc --registry="$REGISTRY" 2>&1 | tail -1
      ;;
  esac
  reconcile_latest_tag
else
  echo "== npm publish --dry-run（确认无误后加 --publish 真发）${DIST_TAG:+ → 将打 tag=${DIST_TAG#--tag }} → $REGISTRY =="
  echo "   真发布后另有一步通道回补：本次版本高于 latest 时把 latest 指到 $VER"
  npm publish --dry-run --registry="$REGISTRY" $DIST_TAG
fi