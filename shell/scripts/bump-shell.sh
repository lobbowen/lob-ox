#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NEW="${1:?用法: bash scripts/bump-shell.sh <version>}"
# 版本格式：壳侧**独立实现**一次完整 SemVer 判定 —— 跨组件纪律「壳只许经契约产物取内核能力，不许 require 内核源码」，故这里**不** require core/src/shared/version.js。判定口径与内核**同源**：字面量抄自 core/src/shared/version.js:8 的 VERSION_RE（完整 SemVer：三段数值禁前导零 + 任意预发布/构建后缀）。⚠ 内核那份若改动，本行须同步。
# 容错：判断放在 `if !` 复合条件里，不用 `$(...)` 捕获非零，set -e 不会终止脚本。
if ! NEW="$NEW" node -e 'const RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;process.exit(RE.test(process.env.NEW||"")?0:1)'; then
  echo "非法版本号（须为合法 SemVer，可带任意预发布后缀，如 1.2.11 / 1.2.11-RC.1 / 1.2.11-test1）: $NEW"; exit 1
fi
ver_lt() {
  node -e "const [a,b]=process.argv.slice(1);const p=(v)=>{const[m,t]=v.split('-');const c=m.split('.').map(Number);const tier=t?(t.startsWith('BETA')?0:1):2;return[c[0],c[1],c[2],tier,t?(Number(t.split('.')[1])||0):0];};const A=p(a),B=p(b);for(let i=0;i<5;i++){if(A[i]<B[i])process.exit(0);if(A[i]>B[i])process.exit(1);}process.exit(1);" "$1" "$2"
}
CUR="$(node -p "require('./src-tauri/tauri.conf.json').version")"
# 只告警不拒绝：版本线可被有意重置（如重置为 1.0.0），届时「低于当前」是常态；真守卫是发布链自身的 registry 自证。
# 判定与信息保留，退出码 0；用 `if` 而非 `&& { ...; }`，set -e 语义无歧义（同本文件版本校验的 `if !` 写法）。
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
# tag 命名空间：壳与内核各自独立版本，而 path 过滤对 tag 推送不生效 ⇒ 两条产线共用 `v*` 时任一 tag 会同时触发两条产线。故按组件前缀分开：壳 = shell-<壳版本>（本行），内核 = core-<内核版本>（core/release/scripts/bump.sh）。不带 `v` 前缀：`shell-` 之后即 tauri.conf.json#version 的字面值，故 tag 与版本可直接对账。
echo "  公开仓 tag 触发仓库根 .github/workflows/shell.yml → 四平台 bundle + npm 壳包"

# 🔴 MSI/WiX 硬约束：Windows 的 msi target 要求**预发布标识必须纯数字且 ≤65535**，否则 `tauri build` 报 `optional pre-release identifier in app version must be numeric-only and cannot be greater than 65535 for msi target` ⇒ 壳**不能用** `1.2.11-test1` 这类含字母的预发布号（Windows 腿会红在 Build + bundle）；需要「不占用正式号的测试发布」时用纯数字预发布 `1.2.11-1`（合 SemVer、满足 WiX、按 dist-tag 结构判断挂 beta 不会污染 latest，且 1.2.11-1 < 1.2.11 不消耗正式号）。内核不受此约束。
