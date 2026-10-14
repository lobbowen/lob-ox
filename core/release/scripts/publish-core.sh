#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="$(node -p "require('./package.json').version")"

PUBLISH=0
SCOPE="$(node -p "try{const p=require('./package.json');(p.npmPublish&&p.npmPublish.scope)||''}catch(e){''}")"
MAIN_LICENSE="$(node -p "require('./package.json').license")"
MAIN_REPO="$(node -p "try{const p=require('./package.json');(p.repository&&p.repository.url)||''}catch(e){''}")"
[ -n "$SCOPE" ] || SCOPE="${DSH_CORE_SCOPE:-}"
[ -n "$SCOPE" ] || SCOPE="@lob-ox"
while [ $# -gt 0 ]; do
  case "$1" in
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
export GEN_PKG_NAME="$PKG_NAME" GEN_VER="$VER" GEN_LICENSE="$MAIN_LICENSE" GEN_REPO="$MAIN_REPO" GEN_STAGE="$STAGE" GEN_PLAT="$PLAT" GEN_ARCH="$ARCH" GEN_OSTAG="$OS_TAG"
node -e 'const fs=require("fs"),e=process.env;const o={name:e.GEN_PKG_NAME,version:e.GEN_VER,description:"DSH lifecycle guard core (Node launcher) for "+e.GEN_OSTAG+"-"+e.GEN_ARCH+" — requires Node >=18.",license:e.GEN_LICENSE,repository:{type:"git",url:e.GEN_REPO},os:[e.GEN_PLAT],cpu:[e.GEN_ARCH],bin:{"lobox":"bin/lobox"},files:["bin","core.cjs","ui-react","README.md"],keywords:["lobox","guard","launcher","core"]};fs.writeFileSync(e.GEN_STAGE+"/package.json",JSON.stringify(o,null,2)+String.fromCharCode(10))'
cat > "$STAGE/README.md" <<EOF

DSH lifecycle guard core — Node launcher 形态（esbuild bundle + node 启动脚本，需 Node ≥18）。
本包仅面向 $OS_TAG-$ARCH （npm os/cpu 平台过滤）。

\`\`\`bash
npm i -g $PKG_NAME
npm i -g $PKG_NAME@beta
npm i -g $PKG_NAME@<version>

lobox self-check
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
DIST_TAG=""
case "$VER" in
  *-RC.*) DIST_TAG="--tag latest" ;;
  *-*)    DIST_TAG="--tag beta" ;;
  *)      DIST_TAG="--tag latest" ;;
esac
REGISTRY="${DSH_PUBLISH_REGISTRY:-https://registry.npmjs.org/}"
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
  REMOTE_SPEC=''
  if REMOTE_SPEC="$(npm view "$PKG_NAME@$VER" --json --registry="$REGISTRY" 2>/dev/null | tr -d '\r')"; then
    LOCAL_SIZE="$(npm pack --dry-run --json --registry="$REGISTRY" 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(b);console.log((j[0]&&j[0].unpackedSize)||"")}catch(e){console.log("")}})' || true)"
    LOCAL_TGZ="$(npm pack --json --registry="$REGISTRY" 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(b);process.stdout.write((Array.isArray(j)?j[0]:j).filename||"")}catch(e){}})' || true)"
    LOCAL_SHA1=''
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
    reconcile_latest_tag
    exit 0
  fi
  echo "== 发布 $PKG_NAME@$VER ${DIST_TAG:-（tag=latest）} → $REGISTRY =="
  PUB_PROV=''
  if [ "${DSH_NPM_PROVENANCE:-1}" != '0' ]; then PUB_PROV='--provenance'; fi
  npm publish --access public --registry="$REGISTRY" $DIST_TAG $PUB_PROV
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
  if npm view "$PKG_NAME@$VER" version --registry="$REGISTRY" >/dev/null 2>&1; then
    echo "   本平台 $PKG_NAME@$VER 已存在于 registry ⇒ dry-run 无需重跑（同版本不可覆盖）"
    exit 0
  fi
  npm publish --dry-run --registry="$REGISTRY" $DIST_TAG
fi