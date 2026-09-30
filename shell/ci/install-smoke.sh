#!/usr/bin/env bash
# 安装冒烟 H10（Linux + macOS）：只执行**装进系统里的那份二进制**，不碰构建树。
# 用法: install-smoke.sh <A包> <A版本> <B包> <B版本> <工作目录>
#   A = 上一个已发布版本的安装包，B = 本次构建产物；先装 A 再覆盖装 B，即用户的升级路径。
# 不覆盖：应用内更新器的下载与应用本身（H7 判签名与清单契约，H11 判通道字节，这里判装与起）。
set -euo pipefail

if [ $# -ne 5 ]; then
  echo '用法: install-smoke.sh <A包> <A版本> <B包> <B版本> <工作目录>'; exit 2
fi
A=$1 AVER=$2 B=$3 BVER=$4 WORK=$5
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
OS=$(uname -s)
STATE=$WORK/state
FK=$WORK/fake-core
case "$OS" in Linux | Darwin) ;; *) echo "本脚本不覆盖该平台: $OS"; exit 2 ;; esac
[ -f "$A" ] || { echo "A 安装包不存在: $A"; exit 1; }
[ -f "$B" ] || { echo "B 安装包不存在: $B"; exit 1; }
rm -rf "$STATE" "$FK"; mkdir -p "$STATE" "$WORK/bin"
# 全程隔离状态根：本机 runner 上可能有真用户状态，读到了就是把别的安装写坏。
export DSH_SUPERVISOR_HOME="$STATE"

fail() { echo "H10 判据失败[$1]: $2" >&2; exit 1; }
hash_of() { (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}'; }

# 装完之后的三项独立事实：二进制自报版本、状态根被尊重、落盘链路可用。
# 版本自报来自安装包内的字节，包管理器记录的版本来自包元数据 —— 两者都要等于期望值。
probe() { # $1=已装二进制 $2=期望版本 $3=包管理器侧版本 $4=标签
  local out id lg want got
  out=$("$1" --shell-update-plan 2>&1) \
    || fail probe "$4 的 --shell-update-plan 退出非零：$out"
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -q "^shell_version=$2" \
    || fail probe "$4 装后的二进制自报版本不是 $2（跑的不是这份安装包）"
  printf '%s\n' "$out" | grep -qF "state_dir=$STATE" \
    || fail probe "$4 装后的状态根不是隔离目录，判据会读到机器上的真状态"
  [ "$3" = "$2" ] || fail pkgmeta "$4 包管理器记录版本 $3 != $2"
  id="$STATE/shell/identity.json"; lg="$STATE/shell/shell.log"
  [ -f "$id" ] || fail persist "$4 没写 identity.json（壳的落盘链路在装机形态下断了）"
  # exe 逐字比对：identity.json 里是壳自己看到的路径，它必须就是刚装进去的那份字节。
  want=$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")
  got=$(sed -n 's/.*"exe"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$id" | head -1)
  if [ "$got" != "$want" ]; then
    cat "$id" >&2
    fail persist "$4 的 identity.json 记的 exe 是 '$got'，期望 '$want'"
  fi
  [ -f "$lg" ] || fail persist "$4 没写 shell.log"
  grep -qF "壳启动 v$2" "$lg" || fail persist "$4 的 shell.log 没有 v$2 的启动行"
}

# Linux：dpkg 直装。依赖需要补齐时只告警不判失败 —— 用户走 sudo apt install ./pkg.deb 同样装得上，
# 但这条告警就是「deb 的 Depends 声明不全」的现场证据。
install_linux() { # $1=deb
  PKG_NAME=$(dpkg-deb -f "$1" Package) || fail install "读不到 Package 字段: $1"
  if ! sudo dpkg -i "$1" >"$WORK/dpkg.log" 2>&1; then
    sudo apt-get update -qq >"$WORK/apt-update.log" 2>&1 || true
    sudo apt-get -y install -f >"$WORK/apt-fix.log" 2>&1 \
      || fail install "$1 装不上且 apt 补不齐依赖，见 $WORK/dpkg.log 与 $WORK/apt-fix.log"
    echo "::warning::$1 需要 apt 补齐依赖才能装成（deb 的 Depends 声明不全）"
  fi
  dpkg -l "$PKG_NAME" 2>/dev/null | grep -q "^ii  *$PKG_NAME " || fail install "$PKG_NAME 未被记为已安装"
  PKG_VER=$(dpkg-query -W -f='${Version}' "$PKG_NAME")
  BIN=$(dpkg -L "$PKG_NAME" | grep -E '^/usr/bin/[^/]+$' | head -1)
  if [ -z "$BIN" ]; then
    dpkg -L "$PKG_NAME" >&2
    fail install "$PKG_NAME 没装出 /usr/bin 下的可执行文件（上面是实际文件清单）"
  fi
}

# macOS 没有包管理器可用，安装语义就是替换 .app —— 与更新器在 mac 上的动作一致。
install_macos() { # $1=dmg $2=标签
  local mnt="$WORK/mnt-$2" app exe_dir
  rm -rf "$mnt" "$WORK/apps/dsh-supervisor.app"; mkdir -p "$mnt" "$WORK/apps"
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$1" -quiet || fail install "挂载 $1 失败"
  app=$(find "$mnt" -maxdepth 1 -name '*.app' | head -1)
  if [ -z "$app" ]; then
    hdiutil detach "$mnt" -quiet || true
    fail install "$1 里没有 .app（dmg 装配有问题）"
  fi
  cp -R "$app" "$WORK/apps/"
  hdiutil detach "$mnt" -quiet || fail install "分离 $mnt 失败"
  exe_dir="$WORK/apps/$(basename "$app")/Contents/MacOS"
  [ -d "$exe_dir" ] || fail install "复制后的 .app 里没有 MacOS 目录: $exe_dir"
  BIN=$(find "$exe_dir" -maxdepth 1 -type f | head -1)
  [ -n "$BIN" ] || fail install "$exe_dir 下没有可执行文件"
  PKG_VER=$(plutil -extract CFBundleShortVersionString raw "$exe_dir/../Info.plist")
}

# Linux 独有一条能把「装好的壳」跑到底的判据链：拉起守卫并按 /healthz 判就绪。
chain_linux() {
  local port=39112
  rm -rf "$FK" "$STATE/supervisor"; mkdir -p "$FK/bin" "$STATE/supervisor"
  printf '{"apiPort":%s}\n' "$port" > "$STATE/supervisor/config.json"
  printf '{"name":"dsh-supervisor-fake","version":"9.9.9"}\n' > "$FK/package.json"
  cp "$SCRIPT_DIR/fake-core.js" "$FK/bin/dsh-supervisor" || fail chain "缺夹具 $SCRIPT_DIR/fake-core.js"
  chmod +x "$FK/bin/dsh-supervisor"
  printf '{"schema":1,"bin":"%s","version":"9.9.9","source":"ci-fake"}\n' "$FK/bin/dsh-supervisor" \
    > "$STATE/supervisor/core.json"
  export DSH_SUPERVISOR_HOME="$STATE"
  # 守卫由 unit 的 Restart=always 反复拉起，只杀进程不删定义会一直复活；runner 上的残留
  # 会污染下一步对拉起次数的计数，所以服务定义与进程都要收口。
  trap 'pkill -f "$FK/bin/dsh-supervisor" 2>/dev/null || true
        systemctl --user disable --now dsh-supervisor.service 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/dsh-supervisor.service"' EXIT
  "$BIN" --watchdog || fail chain "装好的壳未在预算内判为就绪，见 $STATE/shell/shell.log 与 $STATE/shell/guard.log"
  grep -q '"supervisor-api"' "$STATE/supervisor/ports.json" \
    || fail chain "ports.json 缺 supervisor-api 记录（进程没真的绑定端口）"
  "$BIN" --watchdog || fail chain "第二次 --watchdog 没有短路（已就绪应直接返回 0）"
  [ "$(grep -c '\[fake-core\] healthz' "$STATE/shell/guard.log")" = 1 ] \
    || fail chain "第二次 --watchdog 重复拉起了守卫（就绪判据未短路）"
}

# 三平台共用的环境探针：装好的二进制必须自己产出结论，缺任一行即判失败。
chain_plan() {
  local out key
  out=$("$BIN" --node-plan 2>&1) || fail node-plan "装好的壳 --node-plan 退出非零：$out"
  printf '%s\n' "$out"
  for key in node= node_probe_candidates= latest_lts= mirror_selected=; do
    printf '%s\n' "$out" | grep -q "^${key}" || fail node-plan "--node-plan 输出缺 ${key}（结论未产出）"
  done
  out=$("$BIN" --platform-matrix 2>&1) || fail matrix "装好的壳 --platform-matrix 退出非零：$out"
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -q 'definition_path=' || fail matrix "--platform-matrix 无 definition_path"
}

if [ "$OS" = Darwin ]; then install_macos "$A" A; else install_linux "$A"; fi
if [ "$AVER" = "$BVER" ]; then echo "提示：A 与 B 同为 ${AVER}（本次未提升版本），只验覆盖安装与字节替换"; fi
probe "$BIN" "$AVER" "$PKG_VER" A
HASH_A=$(hash_of "$BIN")

if [ "$OS" = Darwin ]; then install_macos "$B" B; else install_linux "$B"; fi
probe "$BIN" "$BVER" "$PKG_VER" B
HASH_B=$(hash_of "$BIN")
# 版本串一致而字节未变 = 覆盖安装没真的换掉文件；这是唯一能区分「装上了新的」的独立证据。
# 只在两版号不同时判：同版本构建（未提升版本的 PR）产物可逐字节相同，那条判据不成立。
if [ "$AVER" != "$BVER" ] && [ "$HASH_A" = "$HASH_B" ]; then
  fail upgrade "覆盖安装后二进制字节没变（sha256=${HASH_B}）"
fi
chain_plan
if [ "$OS" = Linux ]; then chain_linux; fi

if [ "$OS" = Linux ]; then
  sudo dpkg -r "$PKG_NAME" >"$WORK/dpkg-remove.log" 2>&1 \
    || echo "::warning::卸载 $PKG_NAME 失败（判定已在上，见 $WORK/dpkg-remove.log）"
fi
echo "H10 通过：A=$AVER 装得上且落盘 -> B=$BVER 覆盖升级换了字节 -> 装好的壳起得来"
