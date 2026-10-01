#!/usr/bin/env bash
# npm 认证解析共享库；被 publish-core.sh 与 configure-credentials.sh 共同 source。
# DSH 沙箱把 $HOME 指向实例数据目录（状态根单源见 src/platform/service/state-root.js），故「真实用户 home」须经 getent/dscl/~user 解析、不受 $HOME 覆盖；否则同一台机器上 A 实例能发版、B 实例报 ENEEDAUTH。

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

# 只判断存在性，不输出 token 值。
dsh_npmrc_has_token() {
  [ -n "${1:-}" ] && [ -f "$1" ] || return 1
  grep -q "_authToken" "$1" 2>/dev/null
}

dsh_canonical_npmrc() { printf "%s\n" "$(dsh_real_home)/.npmrc"; }

# npm 按 `npm_config_*`（不分大小写）映射配置项，userconfig 上小写 `npm_config_userconfig` 会胜出。
# 故 CI 里 `npm run` 注入的小写值会顶掉我们 export 的大写 -> 读到 runner 无 token 的 ~/.npmrc -> ENEEDAUTH；写入与恢复均须两种都设。

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

dsh_npm_auth__apply() {
  export NPM_CONFIG_USERCONFIG="$1"
  export npm_config_userconfig="$1"
}

dsh_npm_auth_setup() {
  dsh_npm_auth__snapshot
  if [ -n "${DSH_NPMRC:-}" ]; then
    if dsh_npmrc_has_token "$DSH_NPMRC"; then
      dsh_npm_auth__apply "$DSH_NPMRC"; DSH_NPM_AUTH_SOURCE="DSH_NPMRC"; return 0
    fi
    echo "  警告：DSH_NPMRC=$DSH_NPMRC 不含 token" >&2
  fi
  if [ -n "${NPM_CONFIG_USERCONFIG:-}" ] && dsh_npmrc_has_token "$NPM_CONFIG_USERCONFIG"; then
    dsh_npm_auth__apply "$NPM_CONFIG_USERCONFIG"
    DSH_NPM_AUTH_SOURCE="NPM_CONFIG_USERCONFIG"; return 0
  fi
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
  local canon; canon="$(dsh_canonical_npmrc)"
  if dsh_npmrc_has_token "$canon"; then
    dsh_npm_auth__apply "$canon"; DSH_NPM_AUTH_SOURCE="真实 home ($canon)"; return 0
  fi
  if [ "$HOME" != "$(dsh_real_home)" ] && dsh_npmrc_has_token "$HOME/.npmrc"; then
    dsh_npm_auth__apply "$HOME/.npmrc"; DSH_NPM_AUTH_SOURCE="沙箱 \$HOME ($HOME/.npmrc)"; return 0
  fi
  DSH_NPM_AUTH_SOURCE=""
  return 1
}

# 清理（幂等）：删临时 userconfig 并恢复调用前的值（调用方在 EXIT trap 中调用）。
# 不恢复会留下指向已删临时文件的悬空值，同进程后续 npm 调用会莫名失败。
dsh_npm_auth_cleanup() {
  if [ -n "${DSH_NPM_AUTH_TMP:-}" ]; then rm -f "$DSH_NPM_AUTH_TMP"; DSH_NPM_AUTH_TMP=""; fi
  if [ "${DSH_NPM_AUTH_PREV_SET:-0}" = 1 ]; then
    export NPM_CONFIG_USERCONFIG="${DSH_NPM_AUTH_PREV:-}"
  else
    unset NPM_CONFIG_USERCONFIG 2>/dev/null || true
  fi
  if [ "${DSH_NPM_AUTH_PREVL_SET:-0}" = 1 ]; then
    export npm_config_userconfig="${DSH_NPM_AUTH_PREVL:-}"
  else
    unset npm_config_userconfig 2>/dev/null || true
  fi
}

# 认证来源描述（不含密钥值）。
dsh_npm_auth_describe() { printf "%s\n" "${DSH_NPM_AUTH_SOURCE:-无}"; }

