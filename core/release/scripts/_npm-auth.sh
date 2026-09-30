#!/usr/bin/env bash
# 发布链路共享库：npm 认证解析。
# 被 publish-core.sh（发布）与 configure-credentials.sh（配置/自检）共同 source。
#
# -- 为什么需要它（真实故障）--
# DSH 沙箱会把 $HOME 指向实例数据目录（<产品状态根>/supervisor/instances/<id>/data；
#   旧前缀为 ~/.dsh/supervisor，状态根迁移后单源见 src/platform/service/state-root.js）。
# 于是「~/.npmrc 里有没有 token」取决于**你在哪个沙箱里跑**：同一台机器上，
# A 实例能发版、B 实例报 ENEEDAUTH；发布脚本无法自证「为什么登录态时有时无」。
# 且发布/配置脚本原先各自实现认证解析，行为不一致（有的读 $HOME、有的读环境变量）。
#
# -- 唯一解析顺序（越靠前优先级越高）--
#   1. DSH_NPMRC                    显式指定 npmrc 文件（测试/特殊部署）
#   2. NPM_CONFIG_USERCONFIG        npm 原生标准：已设且文件存在 -> 尊重，不干预
#   3. NPM_TOKEN / NODE_AUTH_TOKEN  环境变量 -> 临时 userconfig（0600，退出即删，不落盘）
#   4. <真实用户 home>/.npmrc       规范位置（configure-credentials.sh 写入于此）
#   5. $HOME/.npmrc                 兜底（沙箱内可能存在的旧副本）
#
# 设计要点：「真实用户 home」经 getent/dscl/~user 展开解析，**不受 $HOME 覆盖影响**——
# 这是让发布链路（CI 发布 / 本地 dry-run / 凭据自检）在任何沙箱、任何 shell 下行为一致的关键。

# 解析真实用户 home（POSIX getent -> macOS dscl -> bash ~user 展开 -> Windows USERPROFILE -> $HOME）。
dsh_real_home() {
  if [ -n "${DSH_REAL_HOME:-}" ]; then printf "%s\n" "$DSH_REAL_HOME"; return 0; fi
  local u h
  u="$(id -un 2>/dev/null || whoami 2>/dev/null || true)"
  if [ -n "$u" ]; then
    if command -v getent >/dev/null 2>&1; then
      h="$(getent passwd "$u" 2>/dev/null | cut -d: -f6)"
      if [ -n "$h" ] && [ -d "$h" ]; then printf "%s\n" "$h"; return 0; fi
    fi
    if command -v dscl >/dev/null 2>&1; then
      h="$(dscl . -read "/Users/$u" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
      if [ -n "$h" ] && [ -d "$h" ]; then printf "%s\n" "$h"; return 0; fi
    fi
    h="$(eval printf "%s" "~$u" 2>/dev/null || true)"
    if [ -n "$h" ] && [ "$h" != "~$u" ] && [ -d "$h" ]; then printf "%s\n" "$h"; return 0; fi
  fi
  if [ -n "${USERPROFILE:-}" ] && [ -d "$USERPROFILE" ]; then printf "%s\n" "$USERPROFILE"; return 0; fi
  printf "%s\n" "${HOME:-}"
}

# 指定 npmrc 是否含 auth token（只判断存在性，不输出值）。
dsh_npmrc_has_token() {
  [ -n "${1:-}" ] && [ -f "$1" ] || return 1
  grep -q "_authToken" "$1" 2>/dev/null
}

# 规范 npmrc 路径（真实 home 下）。
dsh_canonical_npmrc() { printf "%s\n" "$(dsh_real_home)/.npmrc"; }

#  必须同时管理**大小写两种**变量：
#   npm 把环境变量按 `npm_config_*`（不分大小写）映射为配置项，二者都落到 `userconfig`，
#   而**小写 npm_config_userconfig 会胜出**。
#   致命场景：CI 里 `npm run publish:core` 由 npm 自身注入 `npm_config_userconfig=$HOME/.npmrc`；
#   我们的 `export NPM_CONFIG_USERCONFIG=<临时文件>` 因此被忽略 -> npm 去读 runner 的 ~/.npmrc
#   （无 token）-> **ENEEDAUTH**。本地因 `~/.npmrc` 恰好有 token 而完全掩盖此缺陷。
#   实测（同一台机）：仅大写 -> npm whoami 成功；再叠加小写指向无 token 文件 -> need auth。
#   故：写入时两种都设，恢复时两种都还原。

# 记录调用前的 userconfig（大写 + 小写），供 cleanup 精确恢复，避免留下悬空/污染值。
dsh_npm_auth__snapshot() {
  if [ -n "${NPM_CONFIG_USERCONFIG:-}" ]; then
    DSH_NPM_AUTH_PREV_SET=1; DSH_NPM_AUTH_PREV="${NPM_CONFIG_USERCONFIG}"
  else
    DSH_NPM_AUTH_PREV_SET=0; DSH_NPM_AUTH_PREV=""
  fi
  if [ -n "${npm_config_userconfig:-}" ]; then
    DSH_NPM_AUTH_PREVL_SET=1; DSH_NPM_AUTH_PREVL="${npm_config_userconfig}"
  else
    DSH_NPM_AUTH_PREVL_SET=0; DSH_NPM_AUTH_PREVL=""
  fi
}

# 应用 userconfig：大小写同时设置（见上方说明，否则小写会覆盖大写）。
dsh_npm_auth__apply() {
  export NPM_CONFIG_USERCONFIG="$1"
  export npm_config_userconfig="$1"
}

# 建立发布认证环境：成功则 export NPM_CONFIG_USERCONFIG 并返回 0，失败返回 1。
# 由调用方决定「无认证」是致命（真发布）还是可容忍（dry-run）。
dsh_npm_auth_setup() {
  dsh_npm_auth__snapshot
  # 1) 显式 npmrc
  if [ -n "${DSH_NPMRC:-}" ]; then
    if dsh_npmrc_has_token "$DSH_NPMRC"; then
      dsh_npm_auth__apply "$DSH_NPMRC"; DSH_NPM_AUTH_SOURCE="DSH_NPMRC"; return 0
    fi
    echo "  警告：DSH_NPMRC=$DSH_NPMRC 不含 token" >&2
  fi
  # 2) npm 原生标准（已设置则尊重；未设时不主动读取进程内可能残留的同名变量）
  if [ -n "${NPM_CONFIG_USERCONFIG:-}" ] && dsh_npmrc_has_token "$NPM_CONFIG_USERCONFIG"; then
    # 已由外部正确指定：仍要同步小写，避免 `npm run` 注入的小写值把它顶掉。
    dsh_npm_auth__apply "$NPM_CONFIG_USERCONFIG"
    DSH_NPM_AUTH_SOURCE="NPM_CONFIG_USERCONFIG"; return 0
  fi
  # 3) 环境变量 token -> 临时 userconfig（不落盘）
  local tok="${NPM_TOKEN:-${NODE_AUTH_TOKEN:-}}"
  if [ -n "$tok" ]; then
    local tmp; tmp="$(mktemp)" || return 1
    chmod 600 "$tmp"
    printf "//registry.npmjs.org/:_authToken=%s\n" "$tok" > "$tmp"
    dsh_npm_auth__apply "$tmp"
    DSH_NPM_AUTH_TMP="$tmp"
    DSH_NPM_AUTH_SOURCE="NPM_TOKEN(临时 userconfig)"
    return 0
  fi
  # 4) 规范位置（真实 home）
  local canon; canon="$(dsh_canonical_npmrc)"
  if dsh_npmrc_has_token "$canon"; then
    dsh_npm_auth__apply "$canon"; DSH_NPM_AUTH_SOURCE="真实 home ($canon)"; return 0
  fi
  # 5) 兜底：$HOME（沙箱内旧副本）
  if [ "$HOME" != "$(dsh_real_home)" ] && dsh_npmrc_has_token "$HOME/.npmrc"; then
    dsh_npm_auth__apply "$HOME/.npmrc"; DSH_NPM_AUTH_SOURCE="沙箱 \$HOME ($HOME/.npmrc)"; return 0
  fi
  DSH_NPM_AUTH_SOURCE=""
  return 1
}

# 清理（幂等）：删除临时 userconfig 并**恢复**调用前的 NPM_CONFIG_USERCONFIG。
# 若不恢复会留下指向已删临时文件的悬空值（同进程内后续 npm 调用会莫名失败）。
# 调用方在 EXIT trap 中调用。
dsh_npm_auth_cleanup() {
  if [ -n "${DSH_NPM_AUTH_TMP:-}" ]; then rm -f "$DSH_NPM_AUTH_TMP"; DSH_NPM_AUTH_TMP=""; fi
  if [ "${DSH_NPM_AUTH_PREV_SET:-0}" = 1 ]; then
    export NPM_CONFIG_USERCONFIG="${DSH_NPM_AUTH_PREV:-}"
  else
    unset NPM_CONFIG_USERCONFIG 2>/dev/null || true
  fi
  # 小写同理（否则会留下指向已删临时文件的悬空值，同进程后续 npm 调用会莫名失败）
  if [ "${DSH_NPM_AUTH_PREVL_SET:-0}" = 1 ]; then
    export npm_config_userconfig="${DSH_NPM_AUTH_PREVL:-}"
  else
    unset npm_config_userconfig 2>/dev/null || true
  fi
}

# 人类可读的认证来源描述（不含任何密钥值）。
dsh_npm_auth_describe() { printf "%s\n" "${DSH_NPM_AUTH_SOURCE:-无}"; }

