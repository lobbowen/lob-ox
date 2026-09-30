#!/usr/bin/env bash
# 版本提升（**内核**）。
#
# 用法:
#   release/scripts/bump.sh --core <ver>   内核版本（唯一事实源=package.json）
#
# 双仓隔离：壳版本提升已迁至壳仓 scripts/bump-shell.sh ——
#   壳的版本号与 Cargo.toml / tauri.conf.json / Cargo.lock 三处互锁全部属于壳自身，
#   不应由内核仓脚本管理（原 --shell 分支正是「壳资产放在内核仓」的违规之一）。
# 只允许递增（>= 当前）；派生处由各自构建脚本读取单源，禁止手改。
set -euo pipefail
# SemVer 逐段数值比较（RC6：字符串比较在 0.10 vs 0.2 场景双向失效）。
ver_lt() {  # ver_lt A B → A < B 时返回 0。Node 实现（bump.sh 本就依赖 node）——
            # SemVer 完整语义：三段数值 + 预发布后缀（BETA<RC<正式），awk 转义版曾因后缀段错位失效。
  node -e "const [a,b]=process.argv.slice(1);const p=(v)=>{const[m,t]=v.split('-');const c=m.split('.').map(Number);const tier=t?(t.startsWith('BETA')?0:1):2;return[c[0],c[1],c[2],tier,t?(Number(t.split('.')[1])||0):0];};const A=p(a),B=p(b);for(let i=0;i<5;i++){if(A[i]<B[i])process.exit(0);if(A[i]>B[i])process.exit(1);}process.exit(1);" "$1" "$2"
}
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[ $# -eq 2 ] || { echo "用法: release/scripts/bump.sh --core <version>"; exit 2; }
MODE="$1"; NEW="${2:?}"
# 版本格式：**委托产品内唯一校验器**（src/shared/version.js:8 的 VERSION_RE），不再内联第二份正则。
#   复（本次修复）：原先此处/壳的 bump-shell.sh/verify-versions.js 各有一份更窄的重复实现
#   （只认 -BETA.n/-RC.n），三处口径必须一致；窄口径会拒掉合法 SemVer（如 0.1.6-BETA.21-test1）。
#   非法 SemVer（1.2 / abc / 1.02.3）在权威校验器下**依旧非法**。
# 容错（既有教训）：不让 `$(...)` 捕获非零 —— 判断直接放在 `if !` 的复合条件里，set -e 不会终止脚本。
# 路径经 env 传**绝对路径**（与 publish-core.sh 的 DSH_VERSION_LIB 同法）：`node -e` 的 require
#   按 cwd 解析，写死相对路径会在 cwd 漂移时 require 失败 ⇒ 合法版本被误判为非法（fail-closed 但报错误导）。
if ! VLIB="$ROOT/src/shared/version.js" NEW="$NEW" node -e 'const {VERSION_RE}=require(process.env.VLIB);process.exit(VERSION_RE.test(process.env.NEW||"")?0:1)'; then
  echo "非法版本号（须为合法 SemVer：主.次.补丁 + 可选任意预发布后缀，如 x.y.z / x.y.z-BETA.1 / x.y.z-test1；与 verify-versions.js 同一判定）: $NEW"; exit 1
fi
case "$MODE" in
  --core)
    CUR="$(node -p "require('./package.json').version")"
    ver_lt "$NEW" "$CUR" && { echo "拒绝回退：$NEW < 当前内核 $CUR"; exit 1; }
    node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p));j.version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    # lock 的两处 version 必须随 package.json 一起提升：只改 package.json 会让 P-9 B26「lock 与之同步」
    # 判据到 CI 才触红，而 bump 是唯一合法写入点，应在源头保持两者一致。
    node -e "const fs=require('fs');const p='package-lock.json';const j=JSON.parse(fs.readFileSync(p));j.version='$NEW';j.packages[''].version='$NEW';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
    node release/scripts/verify-versions.js --core
    echo "=== 内核版本已提升: $CUR → $NEW ==="
    echo "  1) CHANGELOG.md：整理 [未发布] 段为 [$NEW] 并新开 [未发布] —— ⚠️ 该文件已于 2026-10-01 随 .md 清理移出仓库（C:\work\_md_backup）"
    echo "  2) git add -A && git commit && git push origin HEAD（走 PR，CI 全绿后合并）"
    # tag 命名空间（2026-10-01 定案）：内核与壳各自独立版本，而 path 过滤对 tag 推送不生效
    #   ⇒ 两条产线共用 `v*` 时任一 tag 会同时触发内核与壳两条产线。故按组件前缀分开：
    #   内核 = core-<内核版本>（本行），壳 = shell-<壳版本>（shell/scripts/bump-shell.sh）。
    #   不带 `v` 前缀：`core-` 之后即 package.json#version 的字面值，故 tag 与版本可直接对账。
    #   ⚠ 但**没有任何 CI 步骤**做这条对账（core.yml 只读 package.json、不看 tag）⇒ 推错 tag 名不会红。
    echo "  3) 打 tag 并推送：git tag core-$NEW && git push origin core-$NEW"
    echo "  4) 此后**全部由 CI 完成**：四平台完整构建 + 验证 + 各平台发布子包 + 挂 Release 附件"
    echo "     （硬标准：不得在本地构建/发布；本机只到 S0-S3 的版本与纯静态自检，S4 起全在 CI）"
    ;;
  *) echo "未知模式: $MODE （本仓只支持 --core；壳版本见壳仓 scripts/bump-shell.sh）"; exit 2;;
esac