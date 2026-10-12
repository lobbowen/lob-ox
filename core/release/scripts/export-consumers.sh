#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

TRUNC=160

usage() {
  cat <<"USAGE"
用法： release/scripts/export-consumers.sh <符号名> [--defs]
  <符号名>   待检查的导出 / 函数 / 常量名（固定串匹配，正则特殊字符安全）
  --defs     除消费者清单外，另打印定义行（前缀 [def]）
  -h         显示本帮助

输出：消费者逐行 file:line:text（超长截断），随后是定义文件、汇总与「R2 结论」行。
退出码：0 = 正常出结论（含「不可删」）；2 = 用法错误。本工具不是门禁。
USAGE
}

SYM=""
SHOW_DEFS=0
for arg in "$@"; do
  case "${arg}" in
    --defs) SHOW_DEFS=1 ;;
    -h|--help) usage; exit 0 ;;
    --) : ;;
    -*) echo "ERROR: 未知参数：${arg}" >&2; usage >&2; exit 2 ;;
    *)
      if [ -z "${SYM}" ]; then
        SYM="${arg}"
      else
        echo "ERROR: 只接受一个符号名（已收到：${SYM} 与 ${arg}）" >&2
        exit 2
      fi
      ;;
  esac
done
if [ -z "${SYM}" ]; then
  echo "ERROR: 缺少符号名" >&2
  usage >&2
  exit 2
fi

FILES=()
while IFS= read -r f; do
  if [ -n "${f}" ]; then FILES+=("${f}"); fi
done < <(cd "${ROOT}" && find . \( -name node_modules -o -name .git -o -name dist -o -name ui-react -o -name .dsh -o -name .memory -o -name target -o -name coverage -o -name tmp-iso -o -name screenshots \) -prune -o -type f -print | LC_ALL=C sort)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "ERROR: 未找到待扫描文件（仓库根：${ROOT}）" >&2
  exit 2
fi

is_definition_line() {
  local text="$1" sym="$2" kw tail lead pre body
  lead="${text}"
  lead="${lead#"${lead%%[![:space:]]*}"}"
  case "${lead}" in
    "//"*|"*"*|"#"*) return 1 ;;
  esac
  case "${text}" in
    *"//"*)
      pre="${text%%//*}"
      case "${pre}" in
        *[![:space:]]*) : ;;
        *) return 1 ;;
      esac
      ;;
  esac
  for kw in function const let var class; do
    tail="${text#*"${kw} "}"
    if [ "${tail}" != "${text}" ]; then
      case "${tail}" in
        "${sym}"|"${sym}="*|"${sym}("*|"${sym} "*|"${sym},"*) return 0 ;;
      esac
    fi
  done
  case "${text}" in
    *"exports.${sym}"*) return 0 ;;
    *"module.exports ="*"${sym}"*) return 0 ;;
  esac
  body="${lead}"
  case "${body}" in "async "*) body="${body#async }" ;; esac
  case "${body}" in
    "${sym}("*") {"*) return 0 ;;
    "${sym}:"*"function"*) return 0 ;;
    "${sym}:"*"=>"*) return 0 ;;
  esac
  return 1
}

DEF_FILES="|"
add_def_file() {
  case "${DEF_FILES}" in
    *"|$1|"*) : ;;
    *) DEF_FILES="${DEF_FILES}$1|" ;;
  esac
}
in_def_files() {
  case "${DEF_FILES}" in
    *"|$1|"*) return 0 ;;
    *) return 1 ;;
  esac
}
bucket_of() {
  case "$1" in
    design-notes/*) echo "design-notes" ;;
    HANDOFF.md|CHANGELOG.md) echo "design-notes" ;;
    src/*) echo "src" ;;
    test/*) echo "test" ;;
    bin/*) echo "bin" ;;
    release/*) echo "release" ;;
    ui/*) echo "ui" ;;
    *.md) echo "docs" ;;
    *) echo "other" ;;
  esac
}

RAW="$(cd "${ROOT}" && grep -HnFw -I -- "${SYM}" "${FILES[@]}" 2>/dev/null || true)"

TOTAL=0; DEFLINES=0; CONSUMERS=0; IN_DEF_FILE=0; OUTSIDE_R2=0; OUTSIDE_PROC=0
N_SRC=0; N_TEST=0; N_BIN=0; N_RELEASE=0; N_UI=0; N_DOCS=0; N_PROC=0; N_OTHER=0
CONS_LINES=(); DEF_LINES=()

while IFS= read -r hit; do
  if [ -z "${hit}" ]; then continue; fi
  file="${hit%%:*}"
  file="${file#./}"
  rest="${hit#*:}"
  lineno="${rest%%:*}"
  text="${rest#*:}"
  short="${text:0:${TRUNC}}"
  TOTAL=$((TOTAL + 1))
  if is_definition_line "${text}" "${SYM}"; then
    DEFLINES=$((DEFLINES + 1))
    add_def_file "${file}"
    DEF_LINES+=("[def] ${file}:${lineno}:${short}")
    continue
  fi
  CONSUMERS=$((CONSUMERS + 1))
  CONS_LINES+=("${file}:${lineno}:${short}")
  if in_def_files "${file}"; then
    IN_DEF_FILE=$((IN_DEF_FILE + 1))
    continue
  fi
  b="$(bucket_of "${file}")"
  case "${b}" in
    design-notes) OUTSIDE_PROC=$((OUTSIDE_PROC + 1)); N_PROC=$((N_PROC + 1)) ;;
    src) OUTSIDE_R2=$((OUTSIDE_R2 + 1)); N_SRC=$((N_SRC + 1)) ;;
    test) OUTSIDE_R2=$((OUTSIDE_R2 + 1)); N_TEST=$((N_TEST + 1)) ;;
    bin) OUTSIDE_R2=$((OUTSIDE_R2 + 1)); N_BIN=$((N_BIN + 1)) ;;
    release) OUTSIDE_R2=$((OUTSIDE_R2 + 1)); N_RELEASE=$((N_RELEASE + 1)) ;;
    ui) OUTSIDE_R2=$((OUTSIDE_R2 + 1)); N_UI=$((N_UI + 1)) ;;
    docs) OUTSIDE_R2=$((OUTSIDE_R2 + 1)); N_DOCS=$((N_DOCS + 1)) ;;
    *) OUTSIDE_R2=$((OUTSIDE_R2 + 1)); N_OTHER=$((N_OTHER + 1)) ;;
  esac
done <<< "${RAW}"

DEF_DISPLAY="$(printf "%s" "${DEF_FILES}" | tr "|" " " | sed "s/  */ /g; s/^ //; s/ $//")"

THIS_REF=0; THIS_LINES=()
while IFS= read -r _df; do
  [ -z "${_df}" ] && continue
  while IFS= read -r _l; do
    [ -z "${_l}" ] && continue
    THIS_REF=$((THIS_REF + 1))
    THIS_LINES+=("${_l}")
  done < <(cd "${ROOT}" && grep -HnFw -- "this.${SYM}" "${_df}" 2>/dev/null || true)
done < <(printf "%s" "${DEF_FILES}" | tr "|" "\n")

echo "== 符号：${SYM} =="
echo "扫描文件数：${#FILES[@]}（已排除 node_modules/.git/dist/ui-react 等）"
echo
if [ "${CONSUMERS}" -eq 0 ]; then
  echo "（无消费者命中）"
else
  echo "-- 消费者（非定义行；含注释提及，保守全列）--"
  printf "%s\n" "${CONS_LINES[@]}"
fi
if [ "${SHOW_DEFS}" = "1" ]; then
  echo
  if [ "${DEFLINES}" -eq 0 ]; then
    echo "-- 定义行（--defs）：未定位到 --"
  else
    echo "-- 定义行（--defs）--"
    printf "%s\n" "${DEF_LINES[@]}"
  fi
fi
echo
echo "-- 汇总 --"
echo "命中总数：${TOTAL}"
echo "定义行数：${DEFLINES}"
echo "定义文件：${DEF_DISPLAY:-（未定位到）}"
echo "消费者总数（非定义行）：${CONSUMERS}"
echo "  其中定义文件内（同文件内部使用）：${IN_DEF_FILE}"
echo "  其中「定义文件之外」：${OUTSIDE_R2}（计入 R2 判定）"
echo "  其中过程/历史文档：${OUTSIDE_PROC}（不计入 R2 判定）"
if [ "${THIS_REF}" -gt 0 ]; then
  echo
  echo "-- ⚠ 同文件 this.<名> 调用（${THIS_REF} 处；{methods} 门面形态，见头注）--"
  printf "%s\n" "${THIS_LINES[@]}"
fi
echo "定义文件之外消费者分布：src=${N_SRC} test=${N_TEST} bin=${N_BIN} release=${N_RELEASE} ui=${N_UI} docs=${N_DOCS} 过程文档=${N_PROC} 其它=${N_OTHER}"
echo
if [ "${TOTAL}" -eq 0 ]; then
  echo "R2 结论：可删（全仓零命中；请确认符号名拼写是否正确）"
elif [ "${OUTSIDE_R2}" -gt 0 ]; then
  echo "R2 结论：不可删（定义文件之外有 ${OUTSIDE_R2} 处消费者）"
elif [ "${DEFLINES}" -eq 0 ]; then
  echo "R2 结论：不可删（未定位到定义行，保守判定）"
elif [ "${THIS_REF}" -gt 0 ]; then
  echo "R2 结论：需人工确认（同文件内有 ${THIS_REF} 处 this.${SYM} 调用 —— {methods} 门面形态；删前请确认这些调用点的宿主 this 就是该门面，见头注）"
else
  echo "R2 结论：可删（仅定义文件内出现，无外部消费者；若只删导出键，请保留文件内定义）"
fi
exit 0
