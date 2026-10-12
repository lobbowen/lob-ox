#!/usr/bin/env bash
set -euo pipefail
ver_lt() {
  node -e "const [a,b]=process.argv.slice(1);const p=(v)=>{const[m,t]=v.split('-');const c=m.split('.').map(Number);const tier=t?(t.startsWith('BETA')?0:1):2;return[c[0],c[1],c[2],tier,t?(Number(t.split('.')[1])||0):0];};const A=p(a),B=p(b);for(let i=0;i<5;i++){if(A[i]<B[i])process.exit(0);if(A[i]>B[i])process.exit(1);}process.exit(1);" "$1" "$2"
}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[ $# -ge 1 ] || { echo "用法: bump.sh <--core> <新版本>"; exit 2; }
MODE="$1"; NEW="${2:?}"
if ! VLIB="$ROOT/src/shared/version.js" NEW="$NEW" node -e 'const {VERSION_RE}=require(process.env.VLIB);process.exit(VERSION_RE.test(process.env.NEW||"")?0:1)'; then
  echo "非法版本号（须为合法 SemVer：主.次.补丁 + 可选任意预发布后缀，如 x.y.z / x.y.z-BETA.1 / x.y.z-test1；与 verify-versions.js 同一判定）: $NEW"; exit 1
fi
case "$MODE" in
  --core)
    CUR="$(node -p "require('./package.json').version")"
    if ver_lt "$NEW" "$CUR"; then
      echo "[warn] 新版本 $NEW 低于当前内核 $CUR（判定基准 = package.json#version）—— 若不是有意重置版本线，请先确认" >&2
    fi
    node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p));j.version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    node -e "const fs=require('fs');const p='package-lock.json';const j=JSON.parse(fs.readFileSync(p));j.version='$NEW';j.packages[''].version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    node release/scripts/verify-versions.js --core
    echo "=== 内核版本已提升: $CUR → $NEW ==="
    echo "  1) CHANGELOG.md：整理 [未发布] 段为 [$NEW] 并新开 [未发布] —— ⚠️ 本仓无该文件，变更记录随 Release 说明维护"
    echo "  2) git add -A && git commit && git push origin HEAD（走 PR，CI 全绿后合并）"
    echo "  3) 打 tag 并推送：git tag core-$NEW && git push origin core-$NEW"
    echo "  4) 此后**全部由 CI 完成**：四平台完整构建 + 验证 + 各平台发布子包 + 挂 Release 附件"
    echo "     （不得在本地构建/发布；本机只做版本提升与纯静态自检，构建与发布全在 CI）"
    ;;
  *) echo "未知模式: $MODE （本仓只支持 --core；壳版本见壳仓 scripts/bump-shell.sh）"; exit 2;;
esac