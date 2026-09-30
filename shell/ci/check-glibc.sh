#!/usr/bin/env bash
# glibc 基座门禁（跨平台审计 F1 的防线）：断言 Linux 产物不要求高于允许上限的 glibc 符号。
# 用法: ci/check-glibc.sh <binary> [max=2.35]
# 不变量：产物引用的最高 GLIBC 符号不得超过 max（glibc 前向兼容；超限则旧发行版无法运行）。
set -euo pipefail
BIN="${1:?用法: check-glibc.sh <binary> [max]}"; MAX="${2:-2.35}"
[ -f "$BIN" ] || { echo "错误：找不到 $BIN"; exit 2; }

# semver 比较（仅比较 x.y）
vercmp() { [ "$1" = "$2" ] && { echo 0; return; }; printf "%s\n%s\n" "$1" "$2" | sort -V | tail -1 | grep -qx "$1" && echo 1 || echo -1; }
# 判据自证：比较器是唯一的裁决路径，它坏掉时门禁会恒绿（`-gt 0` 永不成立）。
[ "$(vercmp 2.40 2.35)" = 1 ] && [ "$(vercmp 2.35 2.35)" = 0 ] && [ "$(vercmp 2.31 2.35)" = -1 ] \
  || { echo "  ❌ 自校失败：版本比较器不能分辨 2.31/2.35/2.40，本门禁无裁决能力"; exit 2; }

# 提取该二进制引用的所有 GLIBC_x.y 版本（取最高）。
# 取不到符号有两种完全不同的含义：产物真是静态链接（豁免），或工具缺席/读不动（看不见）。
# 旧实现把两者合并成 `exit 0` —— 缺 objdump/readelf 的 runner 上，本门禁从未真正判过。
TOOL=''
command -v objdump >/dev/null 2>&1 && TOOL=objdump
[ -n "$TOOL" ] || { command -v readelf >/dev/null 2>&1 && TOOL=readelf; }
[ -n "$TOOL" ] || { echo "  ❌ objdump 与 readelf 均不可用：无法判定 glibc 基座（缺工具不等于合规）"; exit 2; }
SYM_RC=0
if [ "$TOOL" = objdump ]; then
  SYM_RAW="$(objdump -T "$BIN" 2>&1)" || SYM_RC=$?
else
  SYM_RAW="$(readelf --dyn-syms -W "$BIN" 2>&1)" || SYM_RC=$?
fi
[ "$SYM_RC" = 0 ] || { echo "  ❌ $TOOL 读取 $BIN 失败（退出码 $SYM_RC）：判红而非按通过处理"; exit 2; }
VERS="$(printf "%s\n" "$SYM_RAW" | grep -oE "GLIBC_[0-9]+\.[0-9]+" | sed "s/^GLIBC_//" | sort -uV || true)"
if [ -z "$VERS" ]; then
  # 只有 readelf 成功解析 ELF 且其中确无 PT_INTERP，「零 GLIBC 符号」才是合法豁免。
  PH_RC=0
  PH="$(readelf -lW "$BIN" 2>/dev/null)" || PH_RC=$?
  if [ "$PH_RC" = 0 ] && ! printf "%s\n" "$PH" | grep -q 'INTERP'; then
    echo "  跳过：$BIN 为静态链接（ELF 可解析且无 PT_INTERP），不受 glibc 基座约束"; exit 0
  fi
  echo "  ❌ 未能提取 GLIBC 符号，且静态链接未被证明（readelf 退出码 $PH_RC / 存在 PT_INTERP）：判红而非放过"; exit 2
fi
HIGHEST="$(printf "%s\n" "$VERS" | tail -1)"

echo "== glibc 门禁: $BIN =="
echo "  要求的最高符号: GLIBC_$HIGHEST   允许上限: $MAX"
if [ "$(vercmp "$HIGHEST" "$MAX")" -gt 0 ]; then
  echo "  失败：该产物要求 GLIBC_$HIGHEST > $MAX"
  echo "     发行版兼容性将受限（例如 Ubuntu 22.04 仅有 glibc 2.35）。"
  echo "     修复：在更老的基座上构建（推荐 GitHub runner: ubuntu-22.04）。"
  exit 1
fi
echo "  通过：可在 glibc >= $MAX 的发行版运行"
