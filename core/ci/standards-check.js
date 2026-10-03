#!/usr/bin/env node
'use strict';

// 开发规范里可以机器判定的部分（R2/R3/R5/R6/R9/R10）。只读不写，零依赖。
// 用法：node ci/standards-check.js（与 cwd 无关：所有路径由 __dirname 推导；CI 的 run 步骤 cwd=core/）。
// 判据：任一违规 -> 打 `::error file=<仓库根相对路径>,line=<行号>::` 并最终以非零退出；合规项也逐条打印，
//       豁免一律显式且每次运行都列出（不静默通过）。
// 无法机器判定的操作要求（R1/R4/R7/R8）写在仓库根 STANDARDS.md。

const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const REPO = path.join(CORE, '..');
const TEST_DIR = path.join(CORE, 'test');
// 隐藏目录必须显式拼路径：fs.readdirSync 不做隐藏过滤，但「用 ripgrep 扫仓库」默认跳过隐藏目录 ⇒ 漏检。
const WF_DIR = path.join(REPO, '.github', 'workflows');
const CORE_YML = path.join(WF_DIR, 'core.yml');

// R10：发布后回查 registry 的重试窗口下限（秒）。registry 摄取 + 前置缓存过期是分钟级，
// 窗口短于它会把「PUT 已成功、GET 还没摄取」判成「没发布」= 假红。
const INGEST_WINDOW_FLOOR_SEC = 300;

// R9 豁免表（唯一豁免出口；每次运行都打印；命中数为 0 = 过期豁免，判红）：
// 只收「跳过语义出自结构性前提、而非环境/凭据缺失」的分支；发布/上传类步骤的跳过+exit 0 不接受豁免。
const R9_EXEMPT = [
  {
    file: '.github/workflows/shell.yml',
    step: '取 A（上一个已发布版本的安装包）',
    why: '结构性无 A（本产线尚无更早的已发布版本，或唯一候选与本次同 commit）：该步输出 has_a=false，'
      + '后续步骤各自按 has_a 判定，跳过的是「A→B 升级冒烟」这件当时不存在的事；'
      + '「候选存在却解析不到 commit」等真问题仍在同一步走 ::error:: exit 1。',
  },
];

const violations = [];
const notes = [];
const exemptShown = [];

const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');
const leading = (s) => (/^(\s*)/.exec(s) || ['', ''])[1].length;

function fail(rule, file, line, msg) {
  violations.push({ rule, file: rel(file), line, msg });
}
function note(msg) { notes.push(msg); }

function walkJs(dir, out, skip) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skip || !skip(p, e.name)) walkJs(p, out, skip); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ── 通用：剥离注释（保留字符偏移与行号；字符串字面量原样保留） ───────────────────
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let mode = null; // null | 'line' | 'block' | "'" | '"' | '`'
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === null) {
      if (c === '/' && n === '/') { mode = 'line'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = c; i += 1; continue; }
      i += 1; continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = null; i += 1; continue; } out[i] = ' '; i += 1; continue; }
    if (mode === 'block') {
      if (c === '*' && n === '/') { out[i] = ' '; out[i + 1] = ' '; mode = null; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i += 1; continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === mode) { mode = null; i += 1; continue; }
    i += 1;
  }
  return out.join('');
}

function splitTopLevel(text) {
  const parts = []; let depth = 0; let cur = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if ('([{'.indexOf(c) >= 0) depth += 1;
    if (')]}'.indexOf(c) >= 0) depth -= 1;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function matchParen(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c; i += 1;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// ── R2：`node test/_runner.js --only=<file>` 这条 CI 等价复现路径必须存在 ─────────
function checkR2() {
  const f = path.join(TEST_DIR, '_runner.js');
  if (!fs.existsSync(f)) { fail('R2', f, 1, '_runner.js 不存在：测试唯一入口缺失'); return; }
  const lines = read(f).split('\n');
  const at = (re) => { const i = lines.findIndex((l) => re.test(l)); return i < 0 ? 1 : i + 1; };
  const src = lines.join('\n');
  if (!/flag\(\s*'only'/.test(src) || !/--only/.test(src)) {
    fail('R2', f, at(/only/), '--only=<file> 开关不存在 ⇒ 无法做 CI 等价单文件复现');
  } else {
    note('R2 --only 开关在位（' + rel(f) + ':' + at(/flag\(\s*'only'/) + '）');
  }
  if (!/--only 含未登记条目/.test(src)) {
    fail('R2', f, at(/ONLY/), '--only 未对未登记条目判错 ⇒ 复现路径可静默跑空');
  } else {
    note('R2 未登记条目在 ' + rel(f) + ':' + at(/--only 含未登记条目/) + ' 明确判错（exit 2）');
  }
}

// ── R5：登记表每条必须有非空 why ────────────────────────────────────────────────
function checkR5(manifest, manifestFile) {
  const lines = read(manifestFile).split('\n');
  const lineOf = (file) => {
    const i = lines.findIndex((l) => l.indexOf('file: "' + file + '"') >= 0 || l.indexOf("file: '" + file + "'") >= 0);
    return i < 0 ? 1 : i + 1;
  };
  let okCount = 0;
  manifest.ENTRIES.forEach((e) => {
    const why = e && e.why != null ? String(e.why).trim() : '';
    if (!why) fail('R5', manifestFile, lineOf(e.file), '登记条目缺 why（' + e.file + '）：必须写明为何入链与该条的宿主依赖');
    else okCount += 1;
  });
  note('R5 ' + okCount + '/' + manifest.ENTRIES.length + ' 条登记均有非空 why');
}

// ── R6：登记表 <-> 磁盘 两向零差（判据与 runner 的选跑口径同一份：-test.js 后缀 ∨ IN_CHAIN_LEGACY） ──
const R6_EXEMPT = [
  {
    file: 'test/native-test.js',
    why: '真起 npm 子进程并建符号链接（Windows 需特权/开发者模式），故刻意不入册；'
      + 'core/package.json#_uninstallTests 登记了它的替身（uninstall-timeout-behavior-test / api-contract / plugin-change-restart）。',
  },
];
function checkR6(manifest) {
  const legacy = manifest.IN_CHAIN_LEGACY || [];
  const isTestFile = (name) => /-test\.js$/.test(name) || legacy.indexOf(name) >= 0;
  const disk = fs.readdirSync(TEST_DIR).filter((f) => isTestFile(f)).map((f) => 'test/' + f).sort();
  const registered = manifest.ENTRIES.map((e) => String(e.file));
  const exempt = R6_EXEMPT.map((x) => x.file);

  const dup = registered.filter((f, i) => registered.indexOf(f) !== i);
  if (dup.length) fail('R6', path.join(TEST_DIR, 'manifest.js'), 1, '登记表有重复条目: ' + Array.from(new Set(dup)).join(', '));

  disk.filter((f) => registered.indexOf(f) < 0 && exempt.indexOf(f) < 0)
    .forEach((f) => fail('R6', path.join(CORE, f), 1, '磁盘存在但登记表未收录（该测试永不入链）: ' + f));
  registered.filter((f) => disk.indexOf(f) < 0)
    .forEach((f) => fail('R6', path.join(TEST_DIR, 'manifest.js'), 1, '登记表指向不存在的文件（runner 会 spawn 失败/静默缺跑）: ' + f));

  R6_EXEMPT.forEach((x) => {
    if (!fs.existsSync(path.join(CORE, x.file))) fail('R6', path.join(CORE, x.file), 1, '豁免条目指向不存在的文件（豁免已腐化）: ' + x.file);
    else if (registered.indexOf(x.file) >= 0) fail('R6', path.join(TEST_DIR, 'manifest.js'), 1, '豁免条目已入册（豁免多余）: ' + x.file);
    else if (!String(x.why || '').trim()) fail('R6', path.join(TEST_DIR, 'manifest.js'), 1, '豁免条目缺理由: ' + x.file);
    else exemptShown.push('R6 豁免 ' + x.file + ' —— ' + x.why);
  });

  if (!disk.filter((f) => registered.indexOf(f) < 0 && exempt.indexOf(f) < 0).length
    && !registered.filter((f) => disk.indexOf(f) < 0).length && !dup.length) {
    note('R6 两向零差：磁盘 ' + disk.length + ' 个测试文件 = 登记 ' + registered.length + ' 条 + 豁免 ' + exempt.length + ' 条');
  }
}

// ── R3：禁止自证（期望值一侧无任何字面量，却经由 src/** 导出的函数算出来） ──────
// 判定侧：check(name, 判定[, 证据]) 取第 2 参；assert.x(...) 取全部参数。
// 判为可疑需同时成立：① 该侧不含字面量（字符串 / 数字 / true|false|null|undefined）；
//   ② 该侧出现与 src 导入静态绑定的调用（命名空间成员或解构来的函数）；
//   ③ 该侧含比较运算 —— 期望值与实测值互比的形态（只写 `!!srcFn()` 是对宿主事实的存在性判定，不算期望值）；
//   ④ 该侧不引用「字面量表」里的名字（内联冻结表 / 由该表解构出的循环变量、回调参数 = 独立预言值）。
// 逐条豁免：断言的行范围内写 `// oracle-literal-ok: <理由>`（每次运行都会列出）。
const LITERAL_RE = /'[^']*'|"[^"]*"|\b\d+(?:\.\d+)?\b|\b(?:true|false|null|undefined)\b/;
const ORACLE_OK_RE = /oracle-literal-ok:\s*(\S[^\n]*)/;
const COMPARE_RE = /===|!==|==|!=|<=|>=|<|>/;

// 取 `= <expr>` 到同层 `;` 的文本（跳过括号与字符串），用于识别「字面量表」。
function exprAfter(src, start) {
  let depth = 0; let i = start;
  for (; i < src.length && i - start < 800; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { const q = c; i += 1; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; } continue; }
    if ('([{'.indexOf(c) >= 0) depth += 1;
    else if (')]}'.indexOf(c) >= 0) depth -= 1;
    else if (c === ';' && depth <= 0) break;
  }
  return src.slice(start, i);
}

function literalTables(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    const expr = exprAfter(src, m.index + m[0].length);
    // 只认「内联数据字面量」开头的初值（[ 或 {）：require(路径) 里的字符串不是预言值，
    //   否则 src 命名空间会被误当成字面量表，把 R3 要抓的形态整类豁免掉。
    if (!/^\s*[[{]/.test(expr)) continue;
    if (LITERAL_RE.test(expr)) names.add(m[1]);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s+(\[[^\]]*\]|[A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)/g)) {
      if (names.has(m[2])) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) names.add(n[0]);
    }
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\.(?:every|some|map|filter|forEach|find|reduce)\s*\(\s*(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)/g)) {
      if (names.has(m[1])) names.add(m[2]);
    }
  }
  return names;
}

function checkR3() {
  const files = walkJs(TEST_DIR, [], (p, n) => n === 'fixtures' || n === 'node_modules');
  let scanned = 0;
  let flagged = 0;
  for (const f of files) {
    const raw = read(f);
    const src = stripComments(raw);
    // 只有「静态绑定到 src 导入」的被调名才算：命名空间（const ns = require('<...src...>')）与被解构的函数。
    const ns = new Set();
    const fns = new Set();
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(([\s\S]{0,200}?)\)/g)) {
      if (/src/.test(m[2]) && !/test/.test(m[2])) ns.add(m[1]);
    }
    for (const m of src.matchAll(/(?:const|let|var)\s*\{([\s\S]{0,300}?)\}\s*=\s*require\s*\(([\s\S]{0,200}?)\)/g)) {
      if (!(/src/.test(m[2]) && !/test/.test(m[2]))) continue;
      for (const part of m[1].split(',')) {
        const name = (/^\s*([A-Za-z_$][\w$]*)/.exec(part) || [])[1];
        if (name) fns.add(name);
      }
    }
    const callHasSrc = (text) => {
      for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (ns.has(m[1])) return true;
      }
      for (const m of text.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (fns.has(m[2])) return true;
      }
      return false;
    };
    const tables = literalTables(src);
    const refsLiteralTable = (text) => Array.from(tables).some((v) => new RegExp('(^|[^\\w$.])' + v + '\\b').test(text));

    const re = /\b(check|assert(?:\s*\.\s*[A-Za-z_$][\w$]*)?)\s*\(/g;
    let m;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(src, open);
      if (close < 0) continue;
      const args = splitTopLevel(src.slice(open + 1, close));
      if (!args.length) continue;
      const callee = m[1].replace(/\s+/g, '');
      const side = callee === 'check' ? args[1] : args.join(', ');
      if (side === undefined || !side.trim()) continue;
      scanned += 1;
      if (LITERAL_RE.test(side)) continue;
      if (!COMPARE_RE.test(side.replace(/=>/g, ' '))) continue;
      if (!callHasSrc(side)) continue;
      if (refsLiteralTable(side)) continue;
      const startLine = src.slice(0, m.index).split('\n').length;
      const endLine = src.slice(0, close).split('\n').length;
      const span = raw.split('\n').slice(startLine - 1, endLine).join('\n');
      const ok = ORACLE_OK_RE.exec(span);
      if (ok && String(ok[1]).trim()) {
        exemptShown.push('R3 豁免 ' + rel(f) + ':' + startLine + ' —— ' + String(ok[1]).trim());
        continue;
      }
      flagged += 1;
      fail('R3', f, startLine, '期望值一侧无任何字面量却经由 src 导出函数取到值（自证：期望值由被测实现算出）: '
        + side.trim().replace(/\s+/g, ' ').slice(0, 90));
    }
  }
  note('R3 扫描 ' + files.length + ' 个测试文件 / ' + scanned + ' 条断言，其中 ' + flagged + ' 条判为可疑');
}

// ── 工作流扫描：run: 块提取 ─────────────────────────────────────────────────────
function runBlocks(file) {
  const L = read(file).split('\n');
  const out = [];
  const stepNameAt = (idx) => {
    let start = idx;
    for (let i = idx; i >= 0 && idx - i < 60; i -= 1) {
      if (/^ {6}-\s/.test(L[i])) { start = i; break; }
      if (/^\s*-\s/.test(L[i])) start = i;
    }
    const win = L.slice(start, idx + 1);
    const clean = (s) => String(s).replace(/^['"]|['"]$/g, '');
    for (const l of win) { const m = /^\s*(?:-\s*)?name:\s*(.+?)\s*$/.exec(l); if (m) return clean(m[1]); }
    for (const l of win) { const m = /^\s*(?:-\s*)?id:\s*(.+?)\s*$/.exec(l); if (m) return clean(m[1]); }
    return '';
  };
  for (let i = 0; i < L.length; i += 1) {
    const m = /^(\s*)run:\s*(.*)$/.exec(L[i]);
    if (!m) continue;
    const indent = m[1].length;
    // 只认步骤里的 run（缩进 ≥ 6）：顶层 `defaults: run:`（缩进 2）是工作流级 cwd，不是可判的步骤。
    if (indent < 6) continue;
    const inline = m[2];
    const body = [];
    let j = i + 1;
    if (inline !== '' && !/^[|>]/.test(inline)) {
      body.push([i + 1, inline]);                       // 单行 `run: <命令>`
    } else {
      while (j < L.length && (L[j].trim() === '' || leading(L[j]) > indent)) { body.push([j + 1, L[j]]); j += 1; }
    }
    out.push({ file, step: stepNameAt(i), start: i + 1, end: j, body });
    i = j - 1;
  }
  return out;
}

// ── R9：禁止假绿（跳过语义 + exit 0；关键命令被 || true 吞） ─────────────────────
const SKIP_SEM = /跳过|略过|未配置|无令牌|未提供|不执行|skip|skipped|not configured/i;
const SKIP_ECHO = /\becho\b|::notice::|::warning::|printf|console\.(?:log|warn)/;
const CRED_EMPTY = /-z\s+"?\$\{?[A-Za-z_]*?(?:TOKEN|SECRET|KEY|PASSWORD)/;
const CRITICAL_CMD = /npm\s+publish\b|npm\s+view\b|gh\s+release\s+(?:upload|download)\b|install-smoke-core\.sh|ci-core\.sh|check-glibc\.sh/;
const EXIT_ZERO = /(?:^|[;&|]\s*)exit\s+0\s*$/;
// 「发布/上传类步骤」按块内真跑的命令判定，不按步名猜（步名里的「已发布版本」不是发布动作）。
const DELIVERY_CMD = /npm\s+publish\b|gh\s+release\s+upload\b|ci-core\.sh\s+--publish|--publish-only/;

function checkR9() {
  const files = fs.existsSync(WF_DIR)
    ? fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(WF_DIR, f))
    : [];
  if (!files.length) { fail('R9', WF_DIR, 1, '.github/workflows 下没有工作流文件（隐藏目录扫不到 = 检查空转）'); return; }
  const hitCount = new Map(R9_EXEMPT.map((x) => [x.file + '#' + x.step, 0]));
  let blocksScanned = 0;
  for (const file of files) {
    const blocks = runBlocks(file);
    const declared = read(file).split('\n').filter((l) => /^\s{6,}(?:-\s+)?run:/.test(l)).length;
    if (blocks.length !== declared) {
      fail('R9', file, 1, 'run 步骤扫描数 ' + blocks.length + ' ≠ 文件里的 run: 步骤数 ' + declared + '（漏扫 = 检查空转）');
    }
    blocksScanned += blocks.length;
    for (const block of blocks) {
      const code = block.body.filter(([, l]) => !/^\s*#/.test(l));
      const skipLine = code.find(([, l]) => SKIP_ECHO.test(l) && SKIP_SEM.test(l));
      const exitLine = code.find(([, l]) => EXIT_ZERO.test(l.trim()));
      const credLine = code.find(([, l]) => CRED_EMPTY.test(l));
      const key = rel(file) + '#' + block.step;
      const exempt = R9_EXEMPT.find((x) => x.file === rel(file) && x.step === block.step);

      if (credLine && exitLine) {
        fail('R9', file, exitLine[0], '凭据缺失分支以 exit 0 收场（' + block.step + '）：缺令牌时静默判绿、产物从未发布');
      } else if (skipLine && exitLine) {
        const delivery = DELIVERY_CMD.test(block.body.map(([, l]) => l).join('\n'));
        if (exempt && !delivery) {
          hitCount.set(key, hitCount.get(key) + 1);
          note('R9 跳过但非缺陷 ' + rel(file) + ':' + skipLine[0] + ' [' + block.step + '] —— ' + exempt.why);
        } else {
          fail('R9', file, skipLine[0], (delivery ? '发布/上传类步骤' : '同一 run 块') + '内既有跳过语义又有 exit 0'
            + '（' + block.step + '）：跳过与静默失败不得伪装成成功');
        }
      }
      for (const [ln, l] of code) {
        if (CRITICAL_CMD.test(l) && /\|\|\s*(?:true|:)\s*(?:$|;|#)/.test(l)) {
          fail('R9', file, ln, '关键命令被 `|| true` 吞掉（' + block.step + '）: ' + l.trim().slice(0, 80));
        }
      }
    }
  }
  R9_EXEMPT.forEach((x) => {
    if (!String(x.why || '').trim()) fail('R9', path.join(REPO, x.file), 1, 'R9 豁免缺理由: ' + x.file + '#' + x.step);
    if (!hitCount.get(x.file + '#' + x.step)) fail('R9', path.join(REPO, x.file), 1, 'R9 豁免已过期（不再命中任何跳过+exit 0）: ' + x.file + '#' + x.step);
  });
  note('R9 扫描 ' + files.length + ' 个工作流 / ' + blocksScanned + ' 个 run 块（显式列出 ' + rel(WF_DIR) + '，不经 ripgrep 的隐藏目录默认跳过）');
}

// ── R10：发布后自证的重试窗口下限 ───────────────────────────────────────────────
function checkR10() {
  if (!fs.existsSync(CORE_YML)) { fail('R10', CORE_YML, 1, 'core.yml 不存在：发布后自证无处可查'); return; }
  const blocks = runBlocks(CORE_YML);
  const block = blocks.find((b) => /发布后自证/.test(b.step));
  if (!block) { fail('R10', CORE_YML, 1, '找不到「发布后自证」步：真发布后无回查，跳过与静默失败无从发现'); return; }
  const pick = (name) => {
    const hit = block.body.find(([, l]) => new RegExp('^\\s*' + name + '=\\d+\\s*$').test(l));
    return hit ? { value: Number(/=(\d+)/.exec(hit[1])[1]), line: hit[0] } : null;
  };
  const a = pick('PROBE_ATTEMPTS');
  const s = pick('PROBE_SLEEP_SEC');
  if (!a || !s) {
    fail('R10', CORE_YML, block.start, '自证步的轮次/间隔不再是显式常量（PROBE_ATTEMPTS / PROBE_SLEEP_SEC）⇒ 窗口无法核定');
    return;
  }
  const window = a.value * s.value;
  if (window < INGEST_WINDOW_FLOOR_SEC) {
    fail('R10', CORE_YML, s.line, '自证窗口 ' + window + 's（' + a.value + '×' + s.value + '）< 下限 ' + INGEST_WINDOW_FLOOR_SEC
      + 's：registry 摄取未完成时回查必然落空 ⇒ 把「还没摄取」判成「没发布」；改法：把 PROBE_SLEEP_SEC 提到 ≥ '
      + Math.ceil(INGEST_WINDOW_FLOOR_SEC / a.value) + 's（或加轮次）');
  } else {
    note('R10 自证窗口 ' + window + 's（' + a.value + '×' + s.value + '）≥ 下限 ' + INGEST_WINDOW_FLOOR_SEC + 's');
  }
  const smoke = blocks.find((b) => /冒烟/.test(b.step) && /install-smoke-core/.test(b.body.map(([, l]) => l).join('\n')));
  if (smoke) {
    const t = smoke.body.map(([, l]) => l).join('\n');
    const sa = (/^\s*ATTEMPTS=(\d+)/m.exec(t) || [])[1];
    const ss = (/^\s*SLEEP_SEC=(\d+)/m.exec(t) || [])[1];
    if (sa && ss) note('R10 参照：发布后安装包冒烟窗口 ' + (Number(sa) * Number(ss)) + 's（' + sa + '×' + ss + '）');
  }
}

// ── 登记表加载（只读；本文件不写它） ────────────────────────────────────────────
function loadManifest() {
  const f = path.join(TEST_DIR, 'manifest.js');
  if (!fs.existsSync(f)) { fail('R5', f, 1, 'test/manifest.js 不存在'); return null; }
  try {
    const m = require(f);
    if (!m || !Array.isArray(m.ENTRIES)) throw new Error('ENTRIES 不是数组');
    return m;
  } catch (e) {
    fail('R5', f, 1, '登记表无法加载: ' + ((e && e.message) || e));
    return null;
  }
}


// ── R11：域契约一致性（domains/*/contract.js 是**真门禁**，不是文档）──────────────
// 背景：5 份 contract.js 曾零读取 ⇒ W5 只想删、O-20 只想挂起。但架构规范不该是死文档：
//   契约里声明的 exports / classApi / deps / hooks / pure 全部**可机器判定** ⇒ 必须每次 CI 真跑。
// 判什么：①契约声明的导出与类方法确实存在（不「声明了却没实现」）；
//         ②契约没声明的导出不得凭空出现（不「实现了却没入契」）⇒ 双向零差；
//         ③pure 声明的文件不得有 IO（禁 require 平台层/副作用模块）；
//         ④deps 里声明的键必须在域的构造签名里被消费（不「声明依赖却不用」）。
// 豁免走契约自己的 exempt 字段（每次运行都列出，不静默通过）。
const DOMAIN_ROOT = path.join(CORE, 'src', 'domains');
const DOMAINS = ['instance', 'plugin', 'relay', 'router', 'shell'];

// pure 文件的禁入模块：落到「读机器/进程/网络/文件系统」的一侧才算 IO。
// ⚠️ 不能一刀切禁整个 platform/：platform/contract/* 是纯声明与纯计算（如 dsh-cli.withoutAutoOpen 只做数组处理），
//    禁掉它会把合法的纯依赖误判成 IO（已实测误伤）。故按**副作用目录**逐条列，而不是按顶层目录。
const IO_BANNED = [
  /(^|\/)platform\/os\//,
  /(^|\/)platform\/service\//,
  /(^|\/)platform\/util\/exec/,
  /(^|\/)platform\/distribution\//,
  /(^|\/)platform\/security\//,
  /(^|\/)app\//,
];
const IO_BANNED_BARE = /^(child_process|node:child_process|node:net|node:http|node:https|node:fs|node:dgram|node:tls)$/;

function checkR11() {
  let checked = 0;
  for (const dom of DOMAINS) {
    const contractPath = path.join(DOMAIN_ROOT, dom, 'contract.js');
    if (!fs.existsSync(contractPath)) { fail('R11', contractPath, 1, '域 ' + dom + ' 缺 contract.js：契约是门禁，不是可选项'); continue; }
    let c = null;
    try { c = require(contractPath); } catch (e) { fail('R11', contractPath, 1, '契约无法加载: ' + ((e && e.message) || e)); continue; }
    const idxPath = path.join(DOMAIN_ROOT, dom, 'index.js');
    if (!fs.existsSync(idxPath)) { fail('R11', idxPath, 1, '域 ' + dom + ' 缺 index.js（契约的比对对象）'); continue; }
    let idx = null;
    try { idx = require(idxPath); } catch (e) { fail('R11', idxPath, 1, 'index.js 无法加载: ' + ((e && e.message) || e)); continue; }

    // ① 契约声明的导出必须真的存在
    for (const n of (c.exports || [])) {
      if (!(n in idx)) fail('R11', idxPath, 1, '契约声明导出 ' + n + '，但 index.js 未提供（声明了却没实现）');
    }
    // ①b PUBLIC_API：契约声明的对外面必须真存在（契约里最大的一块，5 域共 130+ 条，此前**从未被验证**）。
    //     三种合法归属，逐一判定（此前只查类 ⇒ 把模块的**函数导出**与**实例属性**都误判成缺失）：
    //       (a) index.js 的模块级导出（函数或任意值）；
    //       (b) classApi 声明的类、或 exports 里的构造器 —— 其原型/静态成员（用描述符查，绝不取值：
    //           InstanceManager#instances 是 getter，未实例化时取它会抛）；
    //       (c) 实例属性（如 InstanceManager 的 this.dshBin）—— 只在**源码里出现 this.<name>** 才算；
    //           拿不到即判「契约声明了却没有实现」，不给模糊豁免。
    const moduleExports = new Set(Object.keys(idx));
    const apiClassTargets = [];
    for (const cls of Object.keys(c.classApi || {})) if (idx[cls]) apiClassTargets.push(idx[cls]);
    for (const n of (c.exports || [])) {
      const v = idx[n];
      if (typeof v === 'function' && v.prototype) apiClassTargets.push(v);
    }
    const hasMember = (O, k) => {
      for (let o = O; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        if (Object.getOwnPropertyDescriptor(o, k)) return true;
      }
      return false;
    };
    let idxSrc = null;
    try { idxSrc = read(idxPath); } catch { idxSrc = null; }
    for (const m of (c.PUBLIC_API || [])) {
      if (typeof m !== 'string') continue;
      if (moduleExports.has(m)) continue;                                     // (a) 模块级导出
      if (apiClassTargets.some((T) => hasMember(T.prototype || {}, m) || hasMember(T, m))) continue; // (b) 类成员
      const isInstanceField = idxSrc ? new RegExp('this\\.' + m + '\\b').test(idxSrc) : false;  // (c) 实例属性
      if (isInstanceField) continue;
      fail('R11', contractPath, 1, '契约 PUBLIC_API 声明 ' + m + '，但域既未导出、也无此成员、源码里也无 this.' + m + '（声明了却没实现）');
    }

    // ② 反向：实现了却没入契（双向零差）
    const declared = new Set(c.exports || []);
    for (const n of Object.keys(idx)) {
      if (!declared.has(n)) fail('R11', contractPath, 1, 'index.js 导出 ' + n + ' 未写入契约（实现了却没入契 ⇒ 契约不再是单源）');
    }

    // ③ classApi：契约声明的类方法必须存在（原型或静态）
    for (const [cls, methods] of Object.entries(c.classApi || {})) {
      const K = idx[cls];
      if (!K) { fail('R11', idxPath, 1, '契约声明类 ' + cls + '，但 index.js 未提供'); continue; }
      for (const m of methods) {
        const ok = (K.prototype && typeof K.prototype[m] === 'function') || typeof K[m] === 'function';
        if (!ok) fail('R11', idxPath, 1, '契约声明 ' + cls + '.' + m + '，但未实现');
      }
    }

    // ④ pure 文件不得有 IO
    for (const relRaw of (c.pure || [])) {
      const rel = String(relRaw).startsWith('domains/') ? String(relRaw) : path.join('domains', String(relRaw));
      const f = path.join(CORE, 'src', rel);
      if (!fs.existsSync(f)) { fail('R11', contractPath, 1, 'pure 声明指向不存在的文件: ' + rel); continue; }
      const src = read(f);
      let lineNo = 1; const lines = src.split('\n');
      lines.forEach((l, i) => {
        const m = /require\((['"])([^'"]+)\1\)/.exec(l);
        if (!m) return;
        const mod = m[2];
        if (IO_BANNED.some((re) => re.test(mod)) || IO_BANNED_BARE.test(mod)) {
          fail('R11', f, i + 1, 'pure 文件不得引入 IO/平台模块: ' + mod + '（声明为纯计算，就不得碰副作用）');
        }
      });
    }

    // ⑤ exempt 必须带理由，且逐条列出（不静默通过）
    for (const [k, why] of Object.entries(c.exempt || {})) {
      if (!String(why || '').trim()) fail('R11', contractPath, 1, 'exempt 条目缺理由: ' + k);
      else exemptShown.push('R11 豁免 [' + dom + '] ' + k + ' —— ' + String(why));
    }
    checked += 1;
  }
  note('R11 域契约一致性：' + checked + '/' + DOMAINS.length + ' 个域已逐条对账（exports / classApi / pure / exempt 双向零差）');
}
function main() {
  console.log('== standards-check：R1..R10 中可机器判定的部分（只读）==');
  checkR2();
  const manifest = loadManifest();
  if (manifest) { checkR5(manifest, path.join(TEST_DIR, 'manifest.js')); checkR6(manifest); }
  checkR3();
  checkR9();
  checkR10();
  checkR11();

  console.log('');
  notes.forEach((n) => console.log('  OK   ' + n));
  if (exemptShown.length) {
    console.log('');
    console.log('  豁免清单（每次运行都列出，不静默通过）:');
    exemptShown.forEach((x) => console.log('    - ' + x));
  }
  console.log('');
  if (violations.length) {
    violations.forEach((v) => {
      console.log('FAIL ' + v.rule + ' ' + v.file + ':' + v.line + ' —— ' + v.msg);
      console.log('::error file=' + v.file + ',line=' + v.line + '::' + v.rule + ' ' + v.msg);
    });
  }
  console.log('== 结果: ' + (violations.length ? violations.length + ' 条违规' : '违规 0 条')
    + '；豁免 ' + exemptShown.length + ' 条 ==');
  console.log('   无法机器判定（见仓库根 STANDARDS.md）: R1 验收只在 CI 四平台 · R4 测试突变验证 · R7 跨语言边界输入比对 · R8 单写者');
  process.exit(violations.length ? 1 : 0);
}

main();
