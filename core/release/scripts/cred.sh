#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$SCRIPT_DIR/_npm-auth.sh"
REAL_HOME="$(dsh_real_home)"
CANON_STORE="$(printf '%s' "$REAL_HOME/develop/.credentials" | tr '\\' '/')"

STORE=${DSH_CRED_DIR:-$CANON_STORE}
STORE=$(printf '%s' "$STORE" | tr '\\' '/')
INDEX="$STORE/index.json"
export INDEX STORE

[ -f "$INDEX" ] || { echo "凭据清单缺失: $INDEX" >&2; exit 1; }

entry_field() {
  node -e "const j=require(process.env.INDEX);const e=j.entries.find(x=>x.name==='$1');
    process.stdout.write(e && e['$2']!=null ? String(e['$2']) : '');"
}

file_of() { entry_field "$1" file; }

case "${1:-list}" in
  list)
    node -e "
      const j=require(process.env.INDEX);
      const pad=(s,n)=>String(s===undefined?'-':s).padEnd(n);
      console.log(pad('名称',16)+pad('类型',26)+pad('账号',14)+pad('状态',10)+'文件');
      for (const e of j.entries) console.log(pad(e.name,16)+pad(e.kind,26)+pad(e.account,14)+pad(e.status,10)+(e.file||''));
    "
    ;;

  path)
    f=$(file_of "$2"); [ -n "$f" ] && echo "$f" || { echo "未知条目: $2" >&2; exit 1; }
    ;;

  get)
    f=$(file_of "$2");
    [ -n "$f" ] || { echo "未知条目: $2" >&2; exit 1; }
    [ -f "$f" ] || { echo "凭据文件不存在: ${f}（状态可能为 missing）" >&2; exit 1; }
    cat "$f"
    ;;

  put)
    f=$(file_of "$2");
    [ -n "$f" ] || { echo "未知条目: $2" >&2; exit 1; }
    IS_REAL=0
    [ "$STORE" = "$CANON_STORE" ] && IS_REAL=1
    if [ "$IS_REAL" = '1' ] && [ "${DSH_CRED_ALLOW_OVERWRITE:-}" != '1' ] && [ "${3:-}" != '--yes' ]; then
      echo "拒绝写入真机凭据库：put 会**覆盖**已有凭据，必须显式确认。" >&2
      echo "  · 真机写入：DSH_CRED_ALLOW_OVERWRITE=1 bash $0 put $2" >&2
      echo "  · 测试/夹具：DSH_CRED_DIR=<tmpdir> bash $0 put $2" >&2
      echo "（本保护来自一次真实事故：注入验证中 put 回落真机库，覆盖了内核令牌。）" >&2
      exit 2
    fi
    if [ "$IS_REAL" = '1' ] && [ -f "$f" ] && [ "${DSH_CRED_FORCE:-}" != '1' ]; then
      echo "拒绝覆盖已存在的真机凭据：$f" >&2
      echo "  如确需轮换，设 DSH_CRED_FORCE=1（会自动备份旧值到 .bak-<时间戳>）。" >&2
      exit 2
    fi
    TMP_IN="$f.tmp.$$"
    if ! ( umask 077; mkdir -p "$(dirname "$f")"; cat > "$TMP_IN" ); then
      rm -f "$TMP_IN" 2>/dev/null || true
      echo "拒绝：读取 stdin 失败，未改动 $f" >&2; exit 2
    fi
    if [ ! -s "$TMP_IN" ] || [ -z "$(tr -d '[:space:]' < "$TMP_IN")" ]; then
      rm -f "$TMP_IN" 2>/dev/null || true
      echo "拒绝：stdin 为空（或只有空白）—— 不落 0 字节凭据、不改 status。$f 保持原样。" >&2
      exit 2
    fi
    if [ -f "$f" ]; then
      BK="$f.bak-$(date +%Y%m%d%H%M%S)"
      ( cp -p "$f" "$BK" && chmod 600 "$BK" ) 2>/dev/null \
        || echo "警告：旧值备份失败（${BK} 未落），写入仍继续；如需保底请先手工复制 ${f}。" >&2
    fi
    cat "$TMP_IN" > "$f"; rm -f "$TMP_IN" 2>/dev/null || true; chmod 600 "$f"
    node -e "
      const fs=require('fs'),p=process.env.INDEX;
      const j=JSON.parse(fs.readFileSync(p,'utf8'));
      const e=j.entries.find(x=>x.name==='$2'); if(e){e.status='active';}
      fs.writeFileSync(p, JSON.stringify(j,null,2)+String.fromCharCode(10));
    "
    echo "已写入 ${f}（0600），status->active"
    ;;

  backup)
    DEST="${2:-}"
    [ -n "$DEST" ] || DEST="${DSH_CRED_BACKUP_DIR:-}"
    [ -n "$DEST" ] || { echo "用法: cred.sh backup <目标目录>（或设 DSH_CRED_BACKUP_DIR）" >&2
      echo "  拒绝用默认值：历史事故就是把凭据放进了**实例目录**（ephemeral，换会话即失效）。" >&2; exit 2; }
    DEST_NORM=${DEST//\\//}
    case "$DEST_NORM" in
      */.dsh/supervisor/instances/*|*/instances/inst-*)
        echo "拒绝：目标在**实例目录**内（${DEST}）—— 那是 ephemeral 的，备份无意义。" >&2; exit 2;;
    esac
    STAMP=$(date +%Y%m%d%H%M%S)
    OUT="$DEST/dsh-credentials-$STAMP"
    umask 077
    mkdir -p "$OUT" && chmod 700 "$OUT"
    cp "$INDEX" "$OUT/" && chmod 600 "$OUT/index.json"
    n=0
    others=$(node -e "const fs=require('fs'),p=require('path');for(const x of fs.readdirSync(process.env.STORE)){if(x!=='index.json'){try{if(fs.statSync(p.join(process.env.STORE,x)).isFile())process.stdout.write(x+String.fromCharCode(10))}catch(e){}}}")
    while IFS= read -r x; do
      [ -n "$x" ] || continue
      cp "$STORE/$x" "$OUT/" && chmod 600 "$OUT/$x" && n=$((n + 1))
    done <<< "$others"
    echo "已备份到 ${OUT}（目录 0700，$((n + 1)) 个文件均 0600）"
    echo "  ⚠ 该副本含**明文令牌**：请置于加密卷/密码管理器，勿入版本库与聊天工具。"
    ;;
  verify)
    VERIFY_WANT="${2:-}" node -e "
      const fs=require('fs');
      const j=require(process.env.INDEX);
      const want=process.env.VERIFY_WANT||'';
      const es=want ? j.entries.filter((e)=>e.name===want) : j.entries;
      if (want && !es.length) { console.log('  未知条目: '+want); process.exit(1); }
      (async () => {
        let bad=0;
        for (const e of es) {
          const v=e.verify||{};
          if (!v.url) { console.log('  '+e.name+'  '+e.status+'（无 API 打点）'); continue; }
          if (!e.file || !fs.existsSync(e.file)) { console.log('  '+e.name+'  **缺凭据文件** '+(e.file||'(未设)')); bad++; continue; }
          let code='000';
          try {
            const r=await fetch(v.url, { headers: { authorization:'Bearer '+fs.readFileSync(e.file,'utf8').trim(), 'user-agent':'dsh-cred-verify' } });
            code=String(r.status);
          } catch (err) { code='ERR'; }
          const ok=(v.expect==null) || String(v.expect)===code;
          if (!ok) bad++;
          console.log('  '+e.name+'  '+(ok?'OK  (HTTP '+code+')':'**异常** HTTP '+code+'（期望 '+v.expect+'）'));
        }
        process.exit(bad?1:0);
      })();
    "
    ;;

  doctor)
    rc=0
    echo '== 1) 目录与文件权限 =='
    IS_WIN=$(node -e "process.stdout.write(process.platform==='win32'?'1':'0')")
    perm_of() { node -e "try{process.stdout.write((require('fs').statSync(process.argv[1]).mode & 0o777).toString(8).padStart(3,'0'))}catch(e){process.stdout.write('?')}" "$1"; }
    if [ "$IS_WIN" = '1' ]; then
      echo '  SKIP  Windows 无 POSIX 权限位（chmod 仅切换只读位）—— 权限断言不适用'
    else
      dm=$(perm_of "$STORE")
      if [ "$dm" = '700' ]; then echo "  OK   库目录 0700"; else echo "  FAIL 库目录权限 ${dm}（应为 700）"; rc=1; fi
      files=$(node -e "const fs=require('fs'),p=require('path');for(const n of fs.readdirSync(process.env.STORE)){try{if(fs.statSync(p.join(process.env.STORE,n)).isFile())process.stdout.write(n+String.fromCharCode(10))}catch(e){}}")
      if [ -z "$files" ]; then echo "  FAIL 库内没有任何文件（清单本身也缺失？）"; rc=1; fi
      while IFS= read -r n; do
        [ -n "$n" ] || continue
        m=$(perm_of "$STORE/$n")
        if [ "$m" = '600' ]; then echo "  OK   $n 0600"; else echo "  FAIL $n 权限 ${m}（应为 600）"; rc=1; fi
      done <<< "$files"
    fi
    echo '== 2) 条目可寻址 + 清单内的文件是否都在库内 =='
    node -e "
      const j=require(process.env.INDEX);
      // 条目靠 name 寻址，缺 name / name 重复时 get/path/put/verify 对该条目失效，必须判红。
      const fs=require('fs');
      //  必须用 ${STORE}（DSH_CRED_DIR 可覆盖），不可硬编码库根 —— 否则换库根就误报
      // 两侧都归一为 / 再比：Windows 的 e.file 可能是反斜杠形式，
      // 而 STORE 已被启动时归一为 /（否则恒不匹配 -> doctor 误报缺项，exit 1）。
      const norm = (x) => String(x).split(String.fromCharCode(92)).join('/');
      const seen = new Set();
      let bad = 0;
      const fail = (msg) => { console.log('  FAIL ' + msg); bad++; };
      if (!Array.isArray(j.entries) || !j.entries.length) fail('清单没有任何条目');
      for (const e of j.entries) {
        const nm = (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : null;
        if (!nm) fail('条目缺 name，工具无法寻址（get/path/put/verify 全失效）: kind=' + e.kind + ' file=' + (e.file || '(未设)'));
        else if (seen.has(nm)) fail('name 重复: ' + nm);
        if (nm) seen.add(nm);
        const ok = e.file && norm(e.file).startsWith(norm(process.env.STORE) + '/');
        if (!ok) fail((nm || '(无 name)') + ' -> ' + (e.file || '(未设)'));
        else console.log('  OK   ' + (nm || '(无 name)') + ' -> ' + e.file);
      }
      if (bad) process.exitCode = 1;
    " || rc=1
    echo '== 3) 缺项（状态非 active）=='
    node -e "
      const j=require(process.env.INDEX);
      let bad=0;
      for (const e of j.entries) if (e.status!=='active' && e.status!=='external') { console.log('  **缺** '+e.name+' ('+e.kind+', '+e.account+') status='+e.status); bad++; }
      if(!bad) console.log('  OK   无缺项');
      if(bad) process.exitCode=1;
    " || rc=1
    if [ "$STORE" != "$CANON_STORE" ]; then
      echo '== 4) 失效散落副本（真机检查）=='
      echo '  SKIP  DSH_CRED_DIR 已覆盖库根 —— 该项只对真机库有意义'
      echo '== 5) 清单内不得含令牌值 =='
      if grep -qE 'github_pat_|ghp_' "$INDEX" 2>/dev/null; then echo '  FAIL 清单里出现了令牌值！'; rc=1; else echo '  OK   清单只有引用，无值'; fi
      exit $rc
    fi
    echo '== 4) 失效散落副本（已知的 ephemeral 位置）=='
    hits=0
    LEGACY="$REAL_HOME/.dsh/github-pat-advgyxqamf"
    if [ -L "$LEGACY" ]; then
      tgt=$(readlink -f "$LEGACY" 2>/dev/null || echo '')
      case "$tgt" in
        "$STORE"/*) echo "  OK   $LEGACY 是指向库内的符号链接（单一副本）";;
        *) echo "  FAIL $LEGACY 符号链接指向库外: $tgt"; rc=1;;
      esac
    elif [ -e "$LEGACY" ]; then
      echo "  FAIL $LEGACY 是**独立副本**（应迁入库并改为符号链接）"; rc=1
    else
      echo "  OK   $LEGACY 不存在（已迁移）"
    fi
    for d in "$REAL_HOME/gh_token.txt" "$REAL_HOME/gh_token" "$REAL_HOME/.gh_token"; do
      [ -e "$d" ] && { echo "  FAIL 发现散落令牌副本 $d"; rc=1; hits=1; }
    done
    [ "$hits" = '0' ] && echo '  OK   无 $HOME 根下的散落副本'
    echo '== 5) 清单内不得含令牌值 =='
    if grep -qE 'github_pat_|ghp_' "$INDEX" 2>/dev/null; then echo '  FAIL 清单里出现了令牌值！'; rc=1; else echo '  OK   清单只有引用，无值'; fi
    exit $rc
    ;;

  *)
    sed -n '2,20p' "$0" | sed 's/^# \?//';
    exit 1
    ;;
esac
