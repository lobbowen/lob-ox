#!/usr/bin/env bash
set -euo pipefail
ver_lt() {
  node -e "const [a,b]=process.argv.slice(1);const p=(v)=>{const[m,t]=v.split('-');const c=m.split('.').map(Number);const tier=t?(t.startsWith('BETA')?0:1):2;return[c[0],c[1],c[2],tier,t?(Number(t.split('.')[1])||0):0];};const A=p(a),B=p(b);for(let i=0;i<5;i++){if(A[i]<B[i])process.exit(0);if(A[i]>B[i])process.exit(1);}process.exit(1);" "$1" "$2"
}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[ $# -eq 2 ] || { echo "用法: release/scripts/bump.sh --core <version>"; exit 2; }
MODE="$1"; NEW="${2:?}"
# 版本格式校验委托 src/shared/version.js 的 VERSION_RE。
# 路径经 env 传绝对路径：node -e 的 require 按 cwd 解析（同 publish-core.sh 的 DSH_VERSION_LIB）。
if ! VLIB="$ROOT/src/shared/version.js" NEW="$NEW" node -e 'const {VERSION_RE}=require(process.env.VLIB);process.exit(VERSION_RE.test(process.env.NEW||"")?0:1)'; then
  echo "非法版本号（须为合法 SemVer：主.次.补丁 + 可选任意预发布后缀，如 x.y.z / x.y.z-BETA.1 / x.y.z-test1；与 verify-versions.js 同一判定）: $NEW"; exit 1
fi
case "$MODE" in
  --core)
    CUR="$(node -p "require('./package.json').version")"
    # 只告警不拒绝：版本线可被有意重置（如重置为 0.0.1），届时「低于当前」是常态；真守卫是发布链自身的 registry 自证。
    # 判定与信息保留，退出码 0；不用 `&& { ...; }` 形态是为了让 set -e 语义无歧义。
    if ver_lt "$NEW" "$CUR"; then
      echo "[warn] 新版本 $NEW 低于当前内核 $CUR（判定基准 = package.json#version）—— 若不是有意重置版本线，请先确认" >&2
    fi
    node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p));j.version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    # package-lock.json 的两处 version 须与 package.json 一致（bump 是唯一写入点）。
    node -e "const fs=require('fs');const p='package-lock.json';const j=JSON.parse(fs.readFileSync(p));j.version='$NEW';j.packages[''].version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    node release/scripts/verify-versions.js --core
    echo "=== 内核版本已提升: $CUR → $NEW ==="
    echo "  1) CHANGELOG.md：整理 [未发布] 段为 [$NEW] 并新开 [未发布] —— ⚠️ 本仓无该文件，变更记录随 Release 说明维护"
    echo "  2) git add -A && git commit && git push origin HEAD（走 PR，CI 全绿后合并）"
    # tag 命名空间：内核 core-<版本>，壳 shell-<版本>（壳仓 scripts/bump-shell.sh）。
    # path 过滤对 tag 推送不生效，故按组件前缀分开；core- 后即 package.json#version 字面值。
    echo "  3) 打 tag 并推送：git tag core-$NEW && git push origin core-$NEW"
    echo "  4) 此后**全部由 CI 完成**：四平台完整构建 + 验证 + 各平台发布子包 + 挂 Release 附件"
    echo "     （不得在本地构建/发布；本机只做版本提升与纯静态自检，构建与发布全在 CI）"
    ;;
  *) echo "未知模式: $MODE （本仓只支持 --core；壳版本见壳仓 scripts/bump-shell.sh）"; exit 2;;
esac