#!/usr/bin/env bash
# 用法: install-smoke-core.sh --pkg <npm 包目录或 name@version spec> --ver <version>
set -euo pipefail

fail() { echo "::error:: $*" >&2; exit 1; }

PKG="" VER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pkg) PKG="${2:?--pkg 需要值}"; shift ;;
    --pkg=*) PKG="${1#*=}" ;;
    --ver) VER="${2:?--ver 需要值}"; shift ;;
    --ver=*) VER="${1#*=}" ;;
    *) fail "未知参数: ${1}（支持 --pkg / --ver）" ;;
  esac
  shift
done
[ -n "$PKG" ] || fail "缺少 --pkg"
[ -n "$VER" ] || fail "缺少 --ver"

# 全新隔离状态根：ports.json 里没有前任守卫的残留记录，「supervisor-api 唯一」才是真判据而非空表假绿。
BASE="${RUNNER_TEMP:-}"
[ -n "$BASE" ] || BASE="$(mktemp -d)"
SMOKE_HOME="$BASE/dsh-install-smoke-$$"
mkdir -p "$SMOKE_HOME/supervisor"
PORTS_JSON="$SMOKE_HOME/supervisor/ports.json"
DAEMON_LOG="$SMOKE_HOME/daemon.log"
# 高位端口：即便被占，守卫会自己顺延并把实际端口写进 ports.json，故下面按登记值复核而非信任此值。
CONFIG_PORT=45757
TARGET_PORT=45758
# command / healthUrl 是业务键，不在平台默认值里（桌面壳装机时写进 config.json）；
# 只写 apiPort 会让 daemon 在 normalize 处 fail-fast。被管目标用 test/mock-target.js 顶替（与 test/smoke.js 共用同一夹具）。
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MOCK="$REPO_ROOT/test/mock-target.js"
[ -f "$MOCK" ] || fail "缺目标夹具 ${MOCK}（守卫需要一个可探测的 healthUrl）"
if command -v cygpath >/dev/null 2>&1; then MOCK="$(cygpath -w "$MOCK")"; fi
# 路径经 argv 传入：Windows 转换后路径含反斜杠，插值进 JS 字面量即成语法陷阱。
node -e 'const fs=require("fs");const [home,mock,tport,apiPort]=process.argv.slice(1);
fs.writeFileSync(home+"/supervisor/config.json",JSON.stringify({apiHost:"127.0.0.1",apiPort:Number(apiPort),
  command:["node",mock,String(tport)],healthUrl:"http://127.0.0.1:"+tport+"/"},null,2)+"\n")' \
  "$SMOKE_HOME" "$MOCK" "$TARGET_PORT" "$CONFIG_PORT" \
  || fail "写入 $SMOKE_HOME/supervisor/config.json 失败"

# npm rm -g 要包名（不是安装 spec）：目录形态取自 package.json.name，registry spec 去掉尾部 @version。
if [ -d "$PKG" ]; then
  UNINSTALL_NAME="$(node -e 'process.stdout.write(require(process.argv[1]).name)' "$PKG/package.json")" || fail "读取 $PKG/package.json 的 name 失败"
else
  UNINSTALL_NAME="${PKG%@*}"
fi

DSH_BIN=""
DSH_PID=""
cleanup() {
  # runner 会被复用：不卸全局命令会污染同 job 后续步骤与别的矩阵腿。
  if [ -n "$DSH_PID" ]; then kill "$DSH_PID" >/dev/null 2>&1 || true; fi
  if [ -n "$UNINSTALL_NAME" ]; then npm rm -g "$UNINSTALL_NAME" >/dev/null 2>&1 || true; fi
}
# 不用 timeout 二进制：Windows 的 timeout.exe 会遮蔽 coreutils timeout 并把「等输入」当命令跑掉；
# trap 按 PID kill 三平台一致，且不留游离进程。
trap cleanup EXIT INT TERM

dsh_run() {
  case "$DSH_BIN" in
    *.cmd) cmd //c "$DSH_BIN" "$@" ;;
    *.ps1) powershell -NoProfile -ExecutionPolicy Bypass -File "$DSH_BIN" "$@" ;;
    *) "$DSH_BIN" "$@" ;;
  esac
}

probe_healthz() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$1/healthz" 2>/dev/null || true)"
  case "$code" in 2*) return 0 ;; *) return 1 ;; esac
}

read_api() {
  node -e 'const fs=require("fs");let d;try{d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(3)}const r=(d.records||[]).filter((x)=>x&&x.role==="supervisor-api");process.stdout.write(r.length+":"+(r.length?r[0].port:""))' "$PORTS_JSON" 2>/dev/null
}

dump_daemon_log() {
  if [ -f "$DAEMON_LOG" ]; then echo "----- daemon 日志 -----"; cat "$DAEMON_LOG"; echo "----- 日志结束 -----"; fi
}

INSTALL_LOG="$SMOKE_HOME/npm-install.log"
echo "== 安装包冒烟: pkg=$PKG ver=$VER =="
# registry spec 必须绕开 packument 缓存（npm 本地与 registry 前置缓存都按 max-age=300 复用），
#   否则调用方重试会读回首轮「尚无此版本」的元数据，包已上架也判 ETARGET。
# 不加引号是有意的：空值要被整体吞掉，加引号会传成一个空参数。
NPM_RESOLVE_OPT=""
[ -d "$PKG" ] || NPM_RESOLVE_OPT="--prefer-online"
# macos-14 腿在 arm64 机上产 darwin-x64 子包会被 npm 拒装（EBADPLATFORM）；本子包纯 JS、运行时依赖 0，
# 故仅此情形带 --force 重装一次——常开 --force 会连带放行真坏掉的包。
if ! npm i -g "$PKG" --no-audit --no-fund $NPM_RESOLVE_OPT >"$INSTALL_LOG" 2>&1; then
  cat "$INSTALL_LOG"
  grep -q EBADPLATFORM "$INSTALL_LOG" || fail "npm i -g 失败: $PKG"
  echo "  宿主与包声明平台不符，按目标平台重装修（仅此一条放行）"
  npm i -g "$PKG" --no-audit --no-fund --force $NPM_RESOLVE_OPT >"$INSTALL_LOG" 2>&1 || { cat "$INSTALL_LOG"; fail "EBADPLATFORM 重装仍失败: $PKG"; }
  cat "$INSTALL_LOG"
fi
rm -f "$INSTALL_LOG"
# 不硬编码单一形态：git-bash 优先命中无后缀 shim，.cmd/.ps1 兜底。
for c in lobox lobox.cmd lobox.ps1; do
  if found="$(command -v "$c" 2>/dev/null)"; then DSH_BIN="$found"; break; fi
done
[ -n "$DSH_BIN" ] || { npm ls -g --depth=0 2>/dev/null || true; fail "装后未找到全局命令 lobox（PATH 无 shim）"; }
echo "  命令解析: $DSH_BIN"

VER_OUT="$(dsh_run --version 2>&1)" || { dump_daemon_log; fail "已安装的 lobox --version 执行失败"; }
case "$VER_OUT" in
  *"$VER"*) echo "  --version 自报匹配 $VER" ;;
  *) echo "----- --version 输出 -----"; printf '%s\n' "$VER_OUT"; fail "--version 输出未含版本 $VER" ;;
esac

SELF_OUT="$(dsh_run self-check 2>&1)" || { echo "----- self-check 输出 -----"; printf '%s\n' "$SELF_OUT"; fail "已安装的 lobox self-check 执行失败"; }
case "$SELF_OUT" in
  *"self-check: OK"*) ;;
  *) echo "----- self-check 输出 -----"; printf '%s\n' "$SELF_OUT"; fail "self-check 未打印 'self-check: OK'" ;;
esac
GV="$(printf '%s\n' "$SELF_OUT" | sed -n 's/^guardVersion=//p' | tr -d '\r' | head -1)"
[ "$GV" = "$VER" ] || { echo "----- self-check 输出 -----"; printf '%s\n' "$SELF_OUT"; fail "self-check guardVersion=$GV ≠ --ver $VER"; }
echo "  self-check 通过: guardVersion=$GV"

: > "$DAEMON_LOG"
DSH_SUPERVISOR_HOME="$SMOKE_HOME" dsh_run daemon >>"$DAEMON_LOG" 2>&1 &
DSH_PID=$!

BUDGET=90
END=$(( $(date +%s) + BUDGET ))
LIVE_PORT=""
while [ "$(date +%s)" -lt "$END" ]; do
  if ! kill -0 "$DSH_PID" 2>/dev/null; then dump_daemon_log; fail "daemon 进程提前退出（守卫未能存活）"; fi
  CAND="$CONFIG_PORT"
  if info="$(read_api)"; then RP="${info#*:}"; [ -n "$RP" ] && CAND="$RP"; fi
  if probe_healthz "$CAND"; then LIVE_PORT="$CAND"; break; fi
  sleep 1
done
[ -n "$LIVE_PORT" ] || { dump_daemon_log; fail "起守卫超时（${BUDGET}s 内 /healthz 未 2xx，候选端口 ${CAND}）"; }
echo "  /healthz 2xx 于端口 $LIVE_PORT"

info="$(read_api)" || { dump_daemon_log; fail "读取 ports.json 失败: $PORTS_JSON"; }
CNT="${info%%:*}"; REC_PORT="${info#*:}"
if [ "$CNT" != "1" ]; then
  echo "----- ports.json -----"; cat "$PORTS_JSON"
  fail "supervisor-api 登记应为唯一 1 条，实为 ${CNT}（内核保证 role 唯一，>1 即残留/双守卫）"
fi
probe_healthz "$REC_PORT" || { dump_daemon_log; fail "ports.json 记录的端口 $REC_PORT 的 /healthz 非 2xx"; }
echo "  ports.json 唯一 supervisor-api 记录 = ${REC_PORT}（与 healthz 端口一致）"

echo "== 安装包冒烟通过 =="
