#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NEW="${1:?用法: bash scripts/bump-shell.sh <version>}"
if ! NEW="$NEW" node -e 'const RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;process.exit(RE.test(process.env.NEW||"")?0:1)'; then
  echo "非法版本号（须为合法 SemVer，可带任意预发布后缀，如 1.2.11 / 1.2.11-RC.1 / 1.2.11-test1）: $NEW"; exit 1
fi
ver_lt() {
  node -e "const [a,b]=process.argv.slice(1);const p=(v)=>{const[m,t]=v.split('-');const c=m.split('.').map(Number);const tier=t?(t.startsWith('BETA')?0:1):2;return[c[0],c[1],c[2],tier,t?(Number(t.split('.')[1])||0):0];};const A=p(a),B=p(b);for(let i=0;i<5;i++){if(A[i]<B[i])process.exit(0);if(A[i]>B[i])process.exit(1);}process.exit(1);" "$1" "$2"
}
CUR="$(node -p "require('./src-tauri/tauri.conf.json').version")"
if ver_lt "$NEW" "$CUR"; then
  echo "[warn] 新版本 $NEW 低于当前壳 $CUR（判定基准 = src-tauri/tauri.conf.json#version）—— 若不是有意重置版本线，请先确认" >&2
fi
_t="$(mktemp)"; sed -E "s/^version = .*/version = \"$NEW\"/" src-tauri/Cargo.toml > "$_t" && mv "$_t" src-tauri/Cargo.toml
_t="$(mktemp)"; sed -E "/^name = \"lobox-shell\"$/{n;s/^version = .*/version = \"$NEW\"/}" src-tauri/Cargo.lock > "$_t" && mv "$_t" src-tauri/Cargo.lock
NEW="$NEW" node -e "const fs=require('fs');const p='src-tauri/tauri.conf.json';const j=JSON.parse(fs.readFileSync(p));j.version=process.env.NEW;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
echo "=== 壳版本已提升: $CUR → $NEW ==="
echo "  1) 更新 CHANGELOG.md —— ⚠️ 本仓无该文件，变更记录随 Release 说明维护"
echo "  2) git add -A && git commit && git push origin HEAD（走 PR：主干有分支保护，直推会被拒）"
echo "  3) CI 全绿后合并，再从主干打 tag 并推送：git tag shell-\$NEW && git push origin shell-\$NEW"
echo "  公开仓 tag 触发仓库根 .github/workflows/shell.yml → 四平台 bundle + npm 壳包"

