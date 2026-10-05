#!/usr/bin/env bash
# 安装冒烟（Linux + macOS）：只执行**装进系统里的那份二进制**，不碰构建树。用法: install-smoke.sh <A包> <A版本> <B包> <B版本> <工作目录>；A = 上一个已发布版本的安装包，B = 本次构建产物；先装 A 再覆盖装 B，即用户的升级路径（不覆盖应用内更新器的下载与应用本身）。
set -euo pipefail

if [ $# -ne 5 ]; then
  echo '用法: install-smoke.sh <A包> <A版本> <B包> <B版本> <工作目录>'; exit 2
fi
A=$1 AVER=$2 B=$3 BVER=$4 WORK=$5
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# 服务/名字一律取自跨语言单源（core/src/shared/brand.js），本脚本不再手写服务名与二进制名。
BRAND_JS="$SCRIPT_DIR/../../core/src/shared/brand.js"
# systemd unit 名已随「服务管理器去系统化」一并移除：安装冒烟不再与任何 OS 服务机制打交道。
# 装后二进制名（= Tauri 打出来的 Cargo 目标名）与 productName（= .app 目录/安装包名）：期望名一律从单源派生。
GUI_BIN=$(node -e 'process.stdout.write(require(process.argv[1]).GUI_BIN_NAME)' "$BRAND_JS")
PRODUCT=$(node -e 'process.stdout.write(require(process.argv[1]).TAURI_PRODUCT_NAME)' "$BRAND_JS")
[ -n "$GUI_BIN" ] || { echo "读不到壳二进制名（单源 $BRAND_JS）"; exit 1; }
[ -n "$PRODUCT" ] || { echo "读不到 productName（单源 $BRAND_JS）"; exit 1; }
OS=$(uname -s)
case "$OS" in Linux) SMOKE_PLATFORM=linux ;; Darwin) SMOKE_PLATFORM=darwin ;; esac
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

# 装后名字断言（Linux/macOS）：**实际落盘**的二进制名/.app 名/CFBundleExecutable 必须逐字等于从单源派生的期望名。
# 为什么必须显式断言：本脚本原先用通配定位装好的壳（`dpkg -L | grep /usr/bin/*`、`find Contents/MacOS | head -1`），
#   Tauri 若把主二进制打成别的名字，通配照样挑得到一个文件、探针照样跑得起来 ⇒ 这一致性永远查不出来，
#   而内核按名字找壳/看护壳的一侧（brand.js#PROC_MATCH_GUI）已经失配。判据实现见 ci/installed-name-check.js（四平台共用）。
# 用法：assert_installed_name <A|B> <实际二进制 basename> [--installer <名>] [--app-dir <名>] [--cf-bundle-executable <名>]
assert_installed_name() {
  local tag="$1" actual="$2"
  shift 2
  node "$SCRIPT_DIR/installed-name-check.js" --platform "$SMOKE_PLATFORM" --tag "$tag" --actual-exe "$actual" "$@" \
    || fail name "$tag 的装后名字断言未通过（判据见上一行的 ::error:: ）"
}

probe() {
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
  want=$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")
  got=$(sed -n 's/.*"exe"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$id" | head -1)
  if [ "$got" != "$want" ]; then
    cat "$id" >&2
    fail persist "$4 的 identity.json 记的 exe 是 '$got'，期望 '$want'"
  fi
  [ -f "$lg" ] || fail persist "$4 没写 shell.log"
  grep -qF "壳启动 v$2" "$lg" || fail persist "$4 的 shell.log 没有 v$2 的启动行"
}

install_linux() {
  PKG_NAME=$(dpkg-deb -f "$1" Package) || fail install "读不到 Package 字段: $1"
  if ! sudo dpkg -i "$1" >"$WORK/dpkg.log" 2>&1; then
    sudo apt-get update -qq >"$WORK/apt-update.log" 2>&1 || true
    sudo apt-get -y install -f >"$WORK/apt-fix.log" 2>&1 \
      || fail install "$1 装不上且 apt 补不齐依赖，见 $WORK/dpkg.log 与 $WORK/apt-fix.log"
    echo "::warning::$1 需要 apt 补齐依赖才能装成（deb 的 Depends 声明不全）"
  fi
  dpkg -l "$PKG_NAME" 2>/dev/null | grep -q "^ii  *$PKG_NAME " || fail install "$PKG_NAME 未被记为已安装"
  PKG_VER=$(dpkg-query -W -f='${Version}' "$PKG_NAME")
  # 落点按单源派生的名字**精确**取（不再 `grep -E '^/usr/bin/[^/]+$' | head -1`：通配挑到哪个文件都算过）。
  BIN="/usr/bin/$GUI_BIN"
  if [ ! -f "$BIN" ]; then
    dpkg -L "$PKG_NAME" >&2
    echo "::error::$PKG_NAME 没装出 /usr/bin/$GUI_BIN（名字由 core/src/shared/brand.js#GUI_BIN_NAME 派生；上面是实际文件清单）"
    fail install "$PKG_NAME 没装出期望的壳可执行文件 /usr/bin/$GUI_BIN"
  fi
  assert_installed_name "$2" "$(basename "$BIN")" --installer "$(basename "$1")"
}

install_macos() {
  local mnt="$WORK/mnt-$2" app exe_dir
  # .app 目录名由 productName 派生（不再 `find -maxdepth 1 -name '*.app' | head -1`：叫什么名的 .app 都能过）。
  app="$mnt/$PRODUCT.app"
  rm -rf "$mnt" "$WORK/apps/$PRODUCT.app"; mkdir -p "$mnt" "$WORK/apps"
  hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$1" -quiet || fail install "挂载 $1 失败"
  if [ ! -e "$app" ]; then
    find "$mnt" -maxdepth 1 >&2 || true
    hdiutil detach "$mnt" -quiet || true
    echo "::error::$1 里没有 $PRODUCT.app（目录名由 shell/src-tauri/tauri.conf.json#productName 派生；上面是 dmg 实际内容）"
    fail install "$1 里没有期望的 $PRODUCT.app（dmg 装配有问题）"
  fi
  cp -R "$app" "$WORK/apps/"
  hdiutil detach "$mnt" -quiet || fail install "分离 $mnt 失败"
  exe_dir="$WORK/apps/$PRODUCT.app/Contents/MacOS"
  [ -d "$exe_dir" ] || fail install "复制后的 .app 里没有 MacOS 目录: $exe_dir"
  # 主二进制名同样按单源派生精确取（不再 `find "$exe_dir" -type f | head -1`）。
  BIN="$exe_dir/$GUI_BIN"
  if [ ! -f "$BIN" ]; then
    find "$exe_dir" -maxdepth 1 -type f >&2 || true
    echo "::error::$exe_dir 下没有期望的壳可执行文件 $GUI_BIN（名字由 core/src/shared/brand.js#GUI_BIN_NAME 派生；上面是实际文件清单）"
    fail install "$exe_dir 下没有期望的壳可执行文件 $GUI_BIN"
  fi
  PKG_VER=$(plutil -extract CFBundleShortVersionString raw "$exe_dir/../Info.plist")
  # Info.plist#CFBundleExecutable 必须与同一期望名一致（它是 launchd/用户点开的入口，与文件名分叉则 mac 上起不来）。
  CF_EXE=$(plutil -extract CFBundleExecutable raw "$exe_dir/../Info.plist") \
    || fail name "读不到 Info.plist#CFBundleExecutable（$exe_dir/../Info.plist）"
  assert_installed_name "$2" "$(basename "$BIN")" --installer "$(basename "$1")" \
    --app-dir "$(basename "$app")" --cf-bundle-executable "$CF_EXE"
}

chain_linux() {
  local port=39112
  rm -rf "$FK" "$STATE/supervisor"; mkdir -p "$FK/bin" "$STATE/supervisor"
  printf '{"apiPort":%s}\n' "$port" > "$STATE/supervisor/config.json"
  printf '{"name":"lobox-fake","version":"9.9.9"}\n' > "$FK/package.json"
  cp "$SCRIPT_DIR/fake-core.js" "$FK/bin/lobox" || fail chain "缺夹具 $SCRIPT_DIR/fake-core.js"
  chmod +x "$FK/bin/lobox"
  printf '{"schema":1,"bin":"%s","version":"9.9.9","source":"ci-fake"}\n' "$FK/bin/lobox" \
    > "$STATE/supervisor/core.json"
  export DSH_SUPERVISOR_HOME="$STATE"
  # ★ 语义（唯一权威：STANDARDS.md）：--watchdog 是**监控**入口，只观测、不拉起。
  #   故受管对象由本步自己起；对它的断言落在观测结论上。收口只需杀进程（不再有 OS 服务定义）。
  trap 'pkill -f "$FK/bin/lobox" 2>/dev/null || true' EXIT

  # ① 未起受管对象 ⇒ 判「不在服役」，且不得把它拉起来、不得产生 ports.json。
  "$BIN" --watchdog || fail chain "--watchdog 退出非零（观测一拍本身失败）"
  grep -q '在服役=false' "$STATE/shell/shell.log" \
    || fail chain "未起受管对象却判为在服役（观测失真），见 $STATE/shell/shell.log"
  pgrep -f "$FK/bin/lobox" >/dev/null \
    && fail chain "监控把未起的受管对象拉起来了（违反只观测）"
  [ ! -f "$STATE/supervisor/ports.json" ] \
    || fail chain "监控在只观测的一拍里写下了 ports.json（有副作用）"

  # ② 起受管对象 ⇒ 按它自报的真实端口判「在服役」。
  node "$FK/bin/lobox" >"$STATE/fake-core.out" 2>&1 &
  for _ in $(seq 1 40); do
    [ -f "$STATE/supervisor/ports.json" ] && break
    sleep 0.5
  done
  [ -f "$STATE/supervisor/ports.json" ] \
    || fail chain "伪内核未就绪，ports.json 未落盘"
  grep -q '"supervisor-api"' "$STATE/supervisor/ports.json" \
    || fail chain "ports.json 缺 supervisor-api 记录（进程没真的绑定端口）"
  "$BIN" --watchdog || fail chain "第二次 --watchdog 退出非零"
  tail -n 5 "$STATE/shell/shell.log" | grep -q '在服役=true' \
    || fail chain "已起受管对象却判为不在服役（端口未接管），见 $STATE/shell/shell.log"
  # ③ 连续观测不得重复拉起（受管对象有且仅有一个实例）。
  [ "$(pgrep -cf "$FK/bin/lobox")" = 1 ] \
    || fail chain "观测把受管对象重复拉起了（应有且仅有 1 个实例）"
}

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

if [ "$OS" = Darwin ]; then install_macos "$A" A; else install_linux "$A" A; fi
if [ "$AVER" = "$BVER" ]; then echo "提示：A 与 B 同为 ${AVER}（本次未提升版本），只验覆盖安装与字节替换"; fi
probe "$BIN" "$AVER" "$PKG_VER" A
HASH_A=$(hash_of "$BIN")

if [ "$OS" = Darwin ]; then install_macos "$B" B; else install_linux "$B" B; fi
probe "$BIN" "$BVER" "$PKG_VER" B
HASH_B=$(hash_of "$BIN")
# 版本串一致而字节未变 = 覆盖安装没真的换掉文件；这是唯一能区分「装上了新的」的独立证据。只在两版号不同时判：同版本构建（未提升版本的 PR）产物可逐字节相同，那条判据不成立。
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
