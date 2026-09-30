#!/usr/bin/env bash
# 删导出前的消费者检查工具（EX / export-consumer）。
#
# ## 为什么有它（动机 = 一次真实 CI 转红）
#   R2 铁律要求「删任何导出/函数/常量前，全仓 grep 消费者」。但本仓仍因**靠人记**而红过一次：
#   src/platform/contract/runtime.js 的 file 导出被当成「仅 read() 内部使用」删除，却漏掉
#   test/native-dsh-binding-test.js 的消费 -> rc.file is not a function（详见 HANDOFF 的红点表）。
#   人的记忆不是可靠接口；把「消费者盘点」变成一条可重复命令，才是这类缺陷的结构解。
#
# ## 它是什么 / 不是什么
#   是：一次命令给出候选符号的全仓命中清单与 R2 判定所需计数，输出 file:line:text。
#   不是：门禁。**刻意不进 test/manifest.js 登记表** —— 它不判生死（恒退出 0），只交事实；
#         塞进 CI 只会多一道永不失败的假绿门禁（假绿门禁比没有更坏）。
#
# ## 判据（R2）
#   符号的**定义行所在文件**视为定义文件；其余文件里的命中即「定义文件之外的消费者」。
#   只要定义文件之外还有消费者 => 不可删。若未定位到定义行，则所有命中都算外部消费者
#   （保守：判不可删）。工具只打印结论行，最终由人决定。
#
# ## 覆盖与保守性
#   - 扫描面 = 仓根全部文本文件，**含 test/ 与 bin/** —— 这两处正是上面那次事故的盲区。
#     排除 node_modules/.git/dist/ui-react 等依赖、产物与运行时目录。
#   - grep -F（固定串）配合 -w（词边界）：符号名含 $ . / 等正则特殊字符也不会出错。
#   - 注释提及与过程文档（design-notes/ 等）照实列出并分类展示：宁可多报，不可漏报 —— 漏报正是事故形态。
#
# ##  已知假阳性：`{methods}` 门面（必读）
#   本工具判据是「**定义文件之外**是否还有命中」。但对 **`{methods}` 门面**（如
#   `src/app/settings/versions.js`、各域 `methods = {...}` 面）这条判据会**报错到「可删」**：
#   门面方法由宿主统一安装，**同一文件内的兄弟方法常以 `this.<名>()` 间接调用** ——
#   该命中落在「定义文件内」，被计为内部使用，于是外部消费者为 0 => 得出错误的「可删」。
#   实例（P4-A 实战）：`settings/versions.js` 的 `_vcsRoot` 定义于:77，被同文件:91/:112 以
#   `this._vcsRoot()` 调用；删了会让那两处运行时失效（同 `rc.file` 事故形态）。
#   本工具已内置守卫：对定义文件补搜 `this.<名>`（grep -Fw，词边界），命中即把结论降级为
#   **「需人工确认」**（见输出「同文件 this.<名> 调用」一节）。守卫只会把结论从「可删」
#   收紧为「需人工确认」，**不会**放宽任何判定 —— 即不会制造新的假「可删」。
#   仍存的边界：非 `this.` 形态的间接调用（如解构后再调、别名变量）本工具看不见，
#   故「可删」**始终需人工确认一次**。
#
# ##  免责（结论仅供参考）
#   每个「可删」候选**必须**用原始 `grep -rn` 复核，并额外检查：
#     (a) 同文件内 `this.<名>` 的间接消费（`{methods}` 门面形态，见上一节）；
#     (b) 动态拼接的符号引用（`grep -F` 只能命中字面量）。
#   **保守原则**：同一行既能被读成声明、又能被读成调用时（门面方法 `x(...) { return mod.x(...) }`
#   正是这种行），**一律按「消费者」处理**，不列入定义集。
#   理由：两个方向的代价不对称 —— 假「可删」会删掉活代码（`rc.file` 式 CI 转红/运行期失效），
#   假「不可删」只多一次人工确认。**工具必须向安全侧失败。**
#
# ## 退出码
#   0 = 找到定义外消费者 / 只有定义 / 无命中（工具不判生死，读结论行即可）。
#   2 = 用法错误（缺符号名、未知参数、多个符号名）。
#
# ## 用法
#   release/scripts/export-consumers.sh <符号名> [--defs]
# 亦可用 bash 前缀调用：bash release/scripts/export-consumers.sh <符号名>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# 输出行文本截断长度（字符）。
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

# - 扫描面：仓根全部文本文件，剪除依赖 / 产物 / 运行时目录 --
FILES=()
while IFS= read -r f; do
  if [ -n "${f}" ]; then FILES+=("${f}"); fi
done < <(cd "${ROOT}" && find . \( -name node_modules -o -name .git -o -name dist -o -name ui-react -o -name .dsh -o -name .memory -o -name target -o -name coverage -o -name tmp-iso -o -name screenshots \) -prune -o -type f -print | LC_ALL=C sort)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "ERROR: 未找到待扫描文件（仓库根：${ROOT}）" >&2
  exit 2
fi

# -- 定义行判据（高精度：宁可漏判定义，不可把消费者误判成定义）--
# 注释行永不是定义：把注释里的示例当定义会掩盖真实消费者，方向错误。
is_definition_line() {
  local text="$1" sym="$2" kw tail lead pre body
  lead="${text}"
  lead="${lead#"${lead%%[![:space:]]*}"}"
  case "${lead}" in
    "//"*|"*"*|"#"*) return 1 ;;
  esac
  # 仅当行注释符之前只有空白时才算注释行（行尾注释不豁免：const X = 1; // note 仍是定义行）
  case "${text}" in
    *"//"*)
      pre="${text%%//*}"
      case "${pre}" in
        *[![:space:]]*) : ;;
        *) return 1 ;;
      esac
      ;;
  esac
  # 1) 声明关键字后紧跟符号：function / const / let / var / class
  for kw in function const let var class; do
    tail="${text#*"${kw} "}"
    if [ "${tail}" != "${text}" ]; then
      case "${tail}" in
        "${sym}"|"${sym}="*|"${sym}("*|"${sym} "*|"${sym},"*) return 0 ;;
      esac
    fi
  done
  # 2) 导出形态
  case "${text}" in
    *"exports.${sym}"*) return 0 ;;
    *"module.exports ="*"${sym}"*) return 0 ;;
  esac
  # 3) 方法 / 箭头形式的对象成员（methods 面）。**行首锚定 + 定义形状**，双条件缺一不可。
  #
  #     两个已复现的系统性假阴性（方向危险：误报「可删」= 删活代码）：
  #    **缺陷 A（子串无左边界）**：`_sandboxTarget(inst) { return targets.sandboxTarget(this, inst); }`
  #      含有 `sandboxTarget(inst) {`，会把门面转发器所在文件误列为定义文件，其内的真实消费点被藏起。
  #    **缺陷 B（无参调用形态无锚定）**：原 `*"${sym}()"*` 会匹配**任意无参调用** ——
  #      `const x = resolveDsh();` 这种纯调用行被判为 resolveDsh 的「定义行」-> 该文件内消费者全被藏。
  #      无需门面，**覆盖全仓**；删掉那一支。
  #
  #    因此：去掉前导空白与可选 `async ` 后，必须以 `sym` **紧跟 `(`** 开头（方法简写形态），
  #    或 `sym:` 开头（对象成员形态）。行内其它位置的调用一律按**消费者**处理。
  body="${lead}"
  case "${body}" in "async "*) body="${body#async }" ;; esac
  case "${body}" in
    "${sym}("*") {"*) return 0 ;;
    "${sym}:"*"function"*) return 0 ;;
    "${sym}:"*"=>"*) return 0 ;;
  esac
  return 1
}

# 定义文件集合（bash 3.2 无关联数组，用分隔串做成员判定）。
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
# 过程 / 历史文档不计入 R2 判定（它们是过程记录，不是契约声明）。
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
  # 归一化 find 的 ./ 前缀：bucket_of 与路径展示都按仓根相对路径判定。
  # （已知边界：仓库内不存在含冒号的文件名；若将来出现，需改用 -z 分隔。）
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

# -- {methods} 门面假阳性守卫（见头注）--
# 对每个定义文件补搜 "this.<SYM>"（-F 固定串 + -w 词边界：SYM=Foo 不会误命中 this.FooBar）。
# 命中即说明该符号被同文件兄弟方法经 this 调用 => 结论降级为「需人工确认」。
# 仅用 bash 3.2 可用特性（不用 mapfile；空数组访问前先判计数，避免 set -u 报错）。
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
