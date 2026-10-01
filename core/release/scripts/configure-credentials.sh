#!/usr/bin/env bash
# 原则：本脚本不接收命令行明文参数、不打印 token、不写仓库内任何文件。
# Git 凭据由 cred.sh 管理，只应存在规范库这一份：repo-local `credential.helper store --file <规范库>/git-credentials`。
# 规范位置 = 真实用户 home 下的 .npmrc（不是沙箱 $HOME）；与 publish-core.sh 共用 _npm-auth.sh 的同一份解析。
#   DSH 沙箱把 $HOME 指向实例数据目录：写到 $HOME/.npmrc 只对该沙箱可见，换沙箱即 ENEEDAUTH。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=./_npm-auth.sh
. "$ROOT/release/scripts/_npm-auth.sh"

REAL_HOME="$(dsh_real_home)"
NPMRC="$(dsh_canonical_npmrc)"
# 权限位读取用 node 而非 `stat -c %a`（GNU 专有：macOS 的 BSD stat 不认，Windows 没有 stat），
#   与 cred.sh 同源，三平台一致。
perm_of() { node -e "try{process.stdout.write((require('fs').statSync(process.argv[1]).mode & 0o777).toString(8).padStart(3,'0'))}catch(e){process.stdout.write('?')}" "$1"; }

write_npmrc() {
  [ -n "${NPM_TOKEN:-}" ] || { echo "❌ NPM_TOKEN 环境变量为空（请先 export NPM_TOKEN=...）"; exit 1; }
  TMP="$(mktemp)"
  if [ -f "$NPMRC" ]; then
    grep -v '^//registry\.npmjs\.org/:_authToken=' "$NPMRC" > "$TMP" || true
  fi
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" >> "$TMP"
  chmod 600 "$TMP"
  mv "$TMP" "$NPMRC"
  chmod 600 "$NPMRC"
  echo "✅ NPM token 已写入规范位置（权限 600）：$NPMRC"
  if [ "$HOME" != "$REAL_HOME" ]; then
    echo "   注意：当前 $HOME($HOME) 与真实 home 不同（沙箱环境）——写入的是真实 home，"
    echo "         故任何沙箱/shell 下的发布都能读到它。"
  fi
  echo "   验证：bash release/scripts/configure-credentials.sh --check"
  unset NPM_TOKEN
}

check() {
  echo "=== 凭据自检（不含值） ==="
  echo "真实 home: $REAL_HOME"
  if [ "$HOME" != "$REAL_HOME" ]; then echo "当前 \$HOME: ${HOME}（沙箱覆盖，不影响发布：解析以真实 home 为准）"; fi
  # 用与 publish-core 完全相同的解析器判定，避免「自检说没配、发布却成功」的错位
  if dsh_npm_auth_setup; then
    echo "NPM: ✅ 命中认证来源 → $(dsh_npm_auth_describe)"
    dsh_npm_auth_cleanup
  else
    # 本机无 npm 认证非缺陷：发布在 CI 经仓库 secret NPM_TOKEN；仅手工 publish 才需 --npm。
    echo "NPM: 本机无认证来源（正常：发布走 CI 的 NPM_TOKEN；仅本机手工 publish 才需 --npm）"
  fi
  if [ -f "$NPMRC" ]; then
    echo "NPM: 规范文件 ${NPMRC}（权限 $(perm_of "$NPMRC")）"
  else
    echo "NPM: 规范文件 $NPMRC 不存在"
  fi
  local cred_file gh_helper_local
  cred_file="$(bash "$ROOT/release/scripts/cred.sh" path git-credentials 2>/dev/null || true)"
  gh_helper_local="$(git config --get credential.helper 2>/dev/null || true)"
  if [ -n "$gh_helper_local" ]; then
    echo "Git: 本仓 repo-local credential.helper = $gh_helper_local"
  else
    echo "Git: 本仓未配 repo-local credential.helper（推送会退回交互输入或失败）"
  fi
  if [ -n "$cred_file" ] && [ -f "$cred_file" ]; then
    echo "Git: 规范库推送凭据存在（权限 $(perm_of "$cred_file")）：$cred_file"
  else
    echo "Git: ❌ 规范库缺少 git-credentials 条目或文件（推送凭据只应存在规范库这一份；缺失时推送会退回交互输入或失败）"
  fi
  if command -v gh >/dev/null 2>&1; then
    echo "gh: 已安装（gh auth status 查登录态）"
  else
    echo "gh: 未安装"
  fi
  # 绝不打印 remote（可能再含 token）；只确认 remote 是否已脱敏
  if git remote -v | grep -q 'github_pat_\|x-access-token:[^@]*@github' 2>/dev/null; then
    echo "⚠️ 警告：remote URL 疑似含明文 token，请立即脱敏"
  else
    echo "remote: 无明文 token（脱敏 OK）"
  fi
  echo "=== 自检完成 ==="
}

case "${1:-}" in
  --npm) write_npmrc ;;
  --git) echo "❌ --git 不再提供：本脚本只管 npm，Git 凭据由 cred.sh 管理。" >&2; exit 2 ;;
  --check) check ;;
  *) echo "用法: configure-credentials.sh --npm | --check"; exit 2 ;;
esac
