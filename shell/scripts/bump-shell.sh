#!/usr/bin/env bash
# 桌面壳版本提升（壳仓自持）。只允许递增；三处互锁同步：
#   src-tauri/Cargo.toml / src-tauri/tauri.conf.json / src-tauri/Cargo.lock
# 用法（壳仓根执行）: bash scripts/bump-shell.sh 1.0.4
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NEW="${1:?用法: bash scripts/bump-shell.sh <version>}"
# 版本格式：壳侧**独立实现**一次完整 SemVer 判定 —— 跨组件纪律「壳只许经契约产物取内核能力，
#   不许 require 内核源码」，故这里**不** require core/src/shared/version.js。
#   判定口径与内核**同源**：字面量抄自 core/src/shared/version.js:8 的 VERSION_RE
#   （完整 SemVer：三段数值禁前导零 + 任意预发布/构建后缀）。⚠ 内核那份若改动，本行须同步。
#   复（本次修复）：原先内联一份更窄的正则（只认 -BETA.n/-RC.n），实测不认 1.2.11-test1，
#   而壳的三个版本文件在 CI 里都按该串走发布链。非法 SemVer（1.2 / abc / 1.02.3）依旧判红。
# 容错（既有教训）：判断放在 `if !` 复合条件里，不用 `$(...)` 捕获非零，set -e 不会终止脚本。
if ! NEW="$NEW" node -e 'const RE=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;process.exit(RE.test(process.env.NEW||"")?0:1)'; then
  echo "非法版本号（须为合法 SemVer，可带任意预发布后缀，如 1.2.11 / 1.2.11-RC.1 / 1.2.11-test1）: $NEW"; exit 1
fi
# SemVer 逐段比较（字符串比较在 0.10 vs 0.2 场景会失效）
ver_lt() {
  node -e "const [a,b]=process.argv.slice(1);const p=(v)=>{const[m,t]=v.split('-');const c=m.split('.').map(Number);const tier=t?(t.startsWith('BETA')?0:1):2;return[c[0],c[1],c[2],tier,t?(Number(t.split('.')[1])||0):0];};const A=p(a),B=p(b);for(let i=0;i<5;i++){if(A[i]<B[i])process.exit(0);if(A[i]>B[i])process.exit(1);}process.exit(1);" "$1" "$2"
}
CUR="$(node -p "require('./src-tauri/tauri.conf.json').version")"
ver_lt "$NEW" "$CUR" && { echo "拒绝回退：$NEW < 当前壳 $CUR"; exit 1; }
_t="$(mktemp)"; sed -E "s/^version = .*/version = \"$NEW\"/" src-tauri/Cargo.toml > "$_t" && mv "$_t" src-tauri/Cargo.toml
# Cargo.lock 中本包版本也需同步（否则 cargo 视为依赖变更）
_t="$(mktemp)"; sed -E "/^name = \"dsh-supervisor-gui\"$/{n;s/^version = .*/version = \"$NEW\"/}" src-tauri/Cargo.lock > "$_t" && mv "$_t" src-tauri/Cargo.lock
NEW="$NEW" node -e "const fs=require('fs');const p='src-tauri/tauri.conf.json';const j=JSON.parse(fs.readFileSync(p));j.version=process.env.NEW;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
# 说明（2026-10-01）：此处原为 `node scripts/verify-shell-versions.js`
#   （校验 Cargo.toml = tauri.conf.json = Cargo.lock 三处版本号文本一致）。
#   该脚本属"文本一致性门禁"，已按用户决定拆除（移至 C:\work\_gate_backup，
#   见 C:\work\_understanding\GATE-REMOVAL-PLAN.md）⇒ 调用一并删除，否则本脚本会因找不到文件而失败。
#   ⚠️ 连带后果：三处版本号是否同步**不再有自动校验**。请在提交前人工确认这三个文件里的版本已一致：
#     src-tauri/Cargo.toml 、src-tauri/tauri.conf.json（上面第 19 行已自动改）、src-tauri/Cargo.lock（第 18 行已自动改）。
echo "=== 壳版本已提升: $CUR → $NEW ==="
echo "  1) 更新 CHANGELOG.md —— ⚠️ 该文件已于 2026-10-01 随 .md 清理移出仓库（C:\work\_md_backup）"
echo "  2) git add -A && git commit && git push origin HEAD（走 PR：主干有分支保护，直推会被拒）"
echo "  3) CI 全绿后合并，再从主干打 tag 并推送：git tag shell-\$NEW && git push origin shell-\$NEW"
# tag 命名空间（2026-10-01 定案）：壳与内核各自独立版本，而 path 过滤对 tag 推送不生效
#   ⇒ 两条产线共用 `v*` 时任一 tag 会同时触发两条产线。故按组件前缀分开：
#   壳 = shell-<壳版本>（本行），内核 = core-<内核版本>（core/release/scripts/bump.sh）。
#   不带 `v` 前缀：`shell-` 之后即 tauri.conf.json#version 的字面值，故 tag 与版本可直接对账。
#   ⚠ 但**没有任何 CI 步骤**做这条对账（shell.yml 的 version job 只读 tauri.conf.json、不看 tag）。
echo "  公开仓 tag 触发仓库根 .github/workflows/shell.yml → 四平台 bundle + npm 壳包"
