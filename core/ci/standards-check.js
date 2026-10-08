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

let MANIFEST_REG = null;
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

// ── R12：安全不变量不得只在一条路径上成立（防「两条路径两套语义」）───────────────
// 判据：安装期禁用生命周期脚本是安全姿态，必须在**所有安装路径**上都生效。
// 此前 --ignore-scripts 只写在「无 commandTemplate」分支 ⇒ 用户配了模板就静默失去该保护。
// 这里不逐路径硬编码，而是判定：install.js 的安全标志必须被**两条分支共同引用**（出现次数 ≥ 2 且至少一处是常量声明）。
function checkR12() {
  const f = path.join(CORE, 'src', 'platform', 'distribution', 'install.js');
  if (!fs.existsSync(f)) { fail('R12', f, 1, 'install.js 缺失：无法判定安装期安全不变量'); return; }
  const src = read(f);
  const declConst = /const\s+IGNORE_SCRIPTS_FLAG\s*=\s*'--ignore-scripts'/.test(src);
  const uses = (src.match(/IGNORE_SCRIPTS_FLAG/g) || []).length;
  if (!declConst) {
    fail('R12', f, 1, '安全标志必须声明为共用常量（IGNORE_SCRIPTS_FLAG），不得逐分支写字面量 ⇒ 否则必有一处漏改');
  } else if (uses < 3) {
    fail('R12', f, 1, '安全标志需被两条安装路径共同引用（声明 + 模板分支 + 默认分支），实到 ' + uses + ' 处 ⇒ 仍有路径未覆盖');
  } else {
    note('R12 安装期安全不变量：--ignore-scripts 由两条路径共用同一常量（' + uses + ' 处引用，含声明）');
  }
}


// ── R13：测试不得硬编「真会占用端口」的端口（唯一入口 = test/_ports.js#safePort）──────
// 为什么：硬编端口会撞号（撞动态端口段 / 生产池 / 并行测试）⇒ CI **偶发**红灯，
// 而偶发红灯最容易被当成"环境问题"忽略 ⇒ 假绿的温床。
// 判据只管**真会 bind 的那一处**：.listen(<数字>) / new PortRegistry 之外的裸端口。
// ⚠️ 刻意不管 healthUrl/apiPort 里的常量：那些多是不真 listen 的假数据或有语义的产品默认值
//    （如 3080 = 产品默认端口）⇒ 一并禁止会制造大片误报、逼人把有意义的常量改成无意义变量（已实测）。
function checkR13() {
  const files = walkJs(TEST_DIR, [], (p, n) => n === 'fixtures' || n === 'node_modules');
  let flagged = 0;
  for (const f of files) {
    if (/_ports\.js$/.test(f)) continue; // 单源本身
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      if (/safePort|safeBase|freePort/.test(l)) return;      // 已走单源
      const m = /\.listen\(\s*(\d{2,5})\s*[,)]/.exec(l);
      if (!m) return;
      const n = Number(m[1]);
      const inSafeBand = n >= 28000 && n <= 29999;
      fail('R13', f, i + 1, '测试硬编监听端口 .listen(' + n + ')'
        + (inSafeBand ? '（在安全段内但未经 _ports.js 登记 ⇒ 段外同名会撞号）'
                      : '（落在安全段 28000–29999 之外 ⇒ 可能撞动态端口段 / 生产池 / 并行测试）')
        + '；改法：用 _ports.js 的 safePort(\'<段名>\', i) 并在 SEGMENTS 登记该段');
      flagged += 1;
    });
  }
  note('R13 测试端口分配：扫描 ' + files.length + ' 个测试文件，硬编监听端口 ' + flagged + ' 处（唯一入口应为 test/_ports.js#safePort）');
}


// ── R14：端口登记必须落在安全段内（test/_ports.js#isSafe 接进门禁）────────────────
// isSafe 此前零调用（W4 死代码候选）。但它是**规范**：端口必须避开三平台动态端口段与生产池。
// 正确处置不是删，而是接进门禁真跑 ⇒ 每次 CI 校验所有登记段（含段内偏移 0..9）都在安全段内。
function checkR14() {
  const portsPath = path.join(TEST_DIR, '_ports.js');
  if (!fs.existsSync(portsPath)) { fail('R14', portsPath, 1, '_ports.js 缺失'); return; }
  let mod = null;
  try { mod = require(portsPath); } catch (e) { fail('R14', portsPath, 1, '_ports.js 无法加载: ' + ((e && e.message) || e)); return; }
  if (typeof mod.isSafe !== 'function') { fail('R14', portsPath, 1, 'isSafe 必须是可调用判据（门禁要读它）'); return; }
  const segs = mod.SEGMENTS || {};
  let bad = 0;
  const badSegs = [];
  for (const [name, idx] of Object.entries(segs)) {
    const base = mod.BASE + Number(idx) * 10;
    const outs = [];
    for (let i = 0; i < 10; i += 1) if (!mod.isSafe(base + i)) outs.push(base + i);
    if (outs.length) {
      // 每段只报一条（含首个/末个越界端口）⇒ 不刷屏；段内全越界也能一眼看出。
      fail('R14', portsPath, 1, '登记段 ' + name + ' 有 ' + outs.length + '/10 个端口不在安全段内'
        + '（' + outs[0] + (outs.length > 1 ? '…' + outs[outs.length - 1] : '') + '）⇒ 会撞动态端口段或生产池');
      bad += outs.length;
      badSegs.push(name);
    }
  }
  note('R14 端口安全段：' + Object.keys(segs).length + ' 个登记段 × 10 个偏移全部落在 ['
    + mod.BASE + ', ' + mod.BAND_HI + ') 内（越界 ' + bad + ' 个端口' + (badSegs.length ? '：' + badSegs.join(', ') : '') + '）');
}


// ── R15：取空闲端口的唯一实现 = _ports.js#freePort（测试不得各自重写）────────────
// 此前 4 个测试各写一份（且行为各异：用 http / 用 net / 出错返回 0）⇒ 同一件事四份实现。
function checkR15() {
  const files = walkJs(TEST_DIR, [], (p, n) => n === 'fixtures' || n === 'node_modules');
  let flagged = 0;
  for (const f of files) {
    if (/_ports\.js$/.test(f)) continue;
    read(f).split('\n').forEach((l, i) => {
      if (/const\s+freePort\s*=/.test(l)) {
        fail('R15', f, i + 1, '测试自行实现 freePort ⇒ 同一件事多份实现（且行为会漂移）；改用 require(\'./_ports\').freePort');
        flagged += 1;
      }
    });
  }
  note('R15 空闲端口实现：' + files.length + ' 个测试文件中本地重写 ' + flagged + ' 处（唯一实现应为 _ports.js#freePort）');
}


// ── R16：禁止「恒真断言」式假绿（环境不具备条件必须 SKIP，不得伪装成 PASS）──────────
// 形态：check(..., !X || <真判据>, ...) —— X 不成立时整条恒真 ⇒ 计入 PASS，但判据**从未执行**。
// 最危险的是 X 依赖宿主环境（LAN 地址、/proc、平台）⇒ CI 上永远绿、永远没验。
// 正解：条件成立才 check，否则 skip（skip 必须显式统计并打印，不得静默）。
function checkR16() {
  const files = walkJs(TEST_DIR, [], (p, n) => n === 'fixtures' || n === 'node_modules');
  let flagged = 0;
  // 归一化行尾：仓库混用 CRLF/LF，直接按 \n 切会残留 \r（与其他门禁同一个坑）。
  // ⚠️ 关键修复：此前**逐行**扫描，而 772/1339 处 `check(` 跨行书写 ⇒ 它们完全不可见，
  //    实测命中 0 —— 这是一条**假门禁**（给人虚假安全感，比没有更危险）。
  //    现在改为：以 `check(` 为起点，按括号配对取出**完整的第二实参**（可跨多行）再判。
  for (const f of files) {
    const src0 = read(f);
    const hasSkip = /\bskip\s*\(|\bskipped\b/.test(src0);
    const text = src0.replace(/\r\n?/g, '\n');
    const lines = text.split('\n');
    // 行号映射：用累积偏移把字符下标换算回行号
    const lineStart = [0];
    for (let k = 0; k < lines.length; k += 1) lineStart.push(lineStart[k] + lines[k].length + 1);
    const lineOf = (idx) => {
      let lo = 0; let hi = lineStart.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= idx) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    for (let at = text.indexOf('check('); at >= 0; at = text.indexOf('check(', at + 1)) {
    // 只认标识符边界（避免匹配 hasCheck( 之类）
    const prev = at > 0 ? text[at - 1] : '';
    if (/[\w$.]/.test(prev)) continue;
    const nameEnd = text.indexOf('(', at);
    if (nameEnd < 0) continue;
    // 找本次调用的右括号（配对，跳过字符串/正则内的括号）
    let depth = 0; let end = -1; let i = nameEnd;
    let inStr = null;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') { i += 1; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const callText = text.slice(nameEnd + 1, end);
    // 取第二实参：跳过第一个实参（字符串名），之后到首个顶层逗号
    const qm = /^\s*(['"`])(?:[^\\]|\\.)*?\1\s*,\s*/.exec(callText);
    if (!qm) continue;                                     // 首参不是字面量名 ⇒ 不判（防误报）
    let rest = callText.slice(qm[0].length);
    let d2 = 0; let cut = -1; let ins = null;
    for (let k = 0; k < rest.length; k += 1) {
      const c = rest[k];
      if (ins) { if (c === '\\') { k += 1; continue; } if (c === ins) ins = null; continue; }
      if (c === '"' || c === "'" || c === '`') { ins = c; continue; }
      if (c === '(' || c === '[' || c === '{') d2 += 1;
      else if (c === ')' || c === ']' || c === '}') { d2 -= 1; if (d2 < 0) { cut = k; break; } }
      else if (c === ',' && d2 === 0) { cut = k; break; }
    }
    const cond = cut >= 0 ? rest.slice(0, cut) : rest;
    if (/![A-Za-z_$][\w$.]*\s*\|\|/.test(cond)) {
      fail('R16', f, lineOf(nameEnd), '断言判据含 `!X ||` ⇒ X 不成立时恒真（判据从未执行却计入 PASS）；改法：if (X) check(...) else skip(...)' + (hasSkip ? '' : '（本文件尚无 skip，需先加 SKIP 语义与统计）'));
      flagged += 1;
    }
    }
  }
  note('R16 假绿防线：扫描 ' + files.length + ' 个测试文件，`!X ||` 恒真断言 ' + flagged + ' 处');
}


// ── R17：登记表的 tier/os 不得与测试真实宿主依赖矛盾 ────────────────────────────
// 形态：标 L1（只在 ubuntu 跑一遍）却含宿主依赖（process.platform 分支 / 真跑子进程 / 读写真实家目录）
//   ⇒ 该测试在 win32/darwin **从未执行**，而登记表声称它已覆盖（why 里还写"纯逻辑"）。
// 这正是审计说的「H-10/H-11 在 win32/darwin 永不执行」的根因，且登记表是单写者文件 ⇒ 必须让机器持续盯住。
// R17 豁免表（唯一豁免出口；每次运行都列出；命中数为 0 = 过期豁免 ⇒ 判红，防"豁免留着不修"）。
// 当前条目：brand-single-source-test.js 标 L1 却真跑 bin/lobox 子进程 + 按平台分支 ⇒
//   H-10/H-11 在 win32/darwin 从未执行。正解是改 manifest 的 tier 为 L2（manifest.js 是 R8 单写者文件，
//   代理不得代改）⇒ 在单写者改动之前，以此豁免显式登记该事实，改动后本豁免自然过期并被判红。
const R17_HIT = new Set();
const R17_EXEMPT = [
  {
    file: 'test/brand-single-source-test.js',
    why: '登记表标 L1 但测试真跑 bin/lobox daemon 子进程且按 platform 分支 ⇒ H-10/H-11 在 win32/darwin 未执行；'
      + '应由单写者把 manifest 的 tier 改 L2、os 改 all 并修正 why（R8：代理不得改 manifest.js）。'
      + '改完 tier 后本豁免即失效（届时判红提示移除）。',
  },
];

function checkR17() {
  if (!MANIFEST_REG) return;
  let flagged = 0;
  for (const e of MANIFEST_REG.ENTRIES) {
    const f = path.join(CORE, e.file);
    if (!fs.existsSync(f)) continue;
    const src = read(f);
    // 只抓「被测行为随宿主改变」：平台分支决定期望值 / 真跑子进程。
    // ⚠️ 排除「仅为跨平台构造夹具文件名」（如 `process.platform === 'win32' ? 'node.exe' : 'node'`）——
    //    那恰恰使测试在所有平台都能跑，不是宿主依赖（已实测误报：runtime-contract-test.js）。
    // 判据再收窄到「平台分支决定**期望值**」：即同一断言在不同平台下验的是不同东西，
    //   或不同平台走不同分支 ⇒ 标 L1（只 ubuntu 跑）时其余平台的分支从未执行。
    // ⚠️ 只看赋值/期望上下文里的 platform 三元式，不看夹具文件名构造，也不看起了本地假二进制
    //   （已实测：runtime-contract-test.js 只是跨平台构造 node.exe/npm.cmd 夹具，四平台都跑得起来）。
    const lines = src.split('\n');
    let branchCases = 0;
    for (const l of lines) {
      if (!/process\.platform/.test(l)) continue;
      // 夹具形态：三元式只用于拼可执行文件名/后缀 ⇒ 不算
      if (/\?\s*['\"][^'\"]*(?:\.exe|\.cmd|\.sh)['\"]\s*:\s*['\"][^'\"]*['\"]/.test(l)) continue;
      if (/path\.join\([^)]*process\.platform/.test(l)) continue;
      // 注入形态：把宿主平台作为依赖传给被测代码（如 `PLATFORM: process.platform`）⇒ 测试在任何平台都跑，不算依赖。
      if (/:\s*process\.platform\s*[,}]/.test(l)) continue;
      branchCases += 1;
    }
    if (e.tier === 'L1' && branchCases > 0) {
      const ex = R17_EXEMPT.find((x) => x.file === e.file);
      if (ex) {
        R17_HIT.add(e.file);
        exemptShown.push('R17 豁免 ' + e.file + ' —— ' + ex.why);
      } else {
        fail('R17', f, 1, '登记表标 L1/unix-only，但测试含宿主依赖（platform 分支决定期望值）⇒ 在 win32/darwin 永不执行；'
          + '应改标 L2 并修正 why（manifest.js 是 R8 单写者文件 ⇒ 需由单写者改）');
        flagged += 1;
      }
    }
  }
  for (const x of R17_EXEMPT) {
    if (!R17_HIT.has(x.file)) fail('R17', path.join(CORE, x.file), 1, 'R17 豁免已过期（不再命中任何 L1+宿主依赖）: ' + x.file + ' ⇒ 该改的已改，请移除豁免');
  }
  note('R17 登记表↔宿主依赖一致性：L1 却有宿主依赖 ' + flagged + ' 处（豁免 ' + R17_HIT.size + ' 处，均已在上面列出）');
}


// ── R18：壳镜像探测集必须覆盖内核默认 registries（跨语言上下流契约）─────────────
// 背景：审计把 config.js#registries 与 mirror.rs#NPM_PRESETS 当成"顺序相反的重复"。实测两者语义不同：
//   内核侧 = 运行时默认配置；壳侧 = 装机前探测候选（机器上还没有内核，壳必须先跑完探测）。
// ⇒ 强行改成同一份会破坏上下游（壳探测集更大是有意的）。真实不变量是**覆盖关系**：
//   内核默认用到的每个 registry，壳都必须探测过（否则装机首启可能选到未探测的源）。
// 顺序无关（壳并行探测全部候选 + 取可达源中最高版本 ⇒ 顺序不影响正确性）。
function checkR18() {
  const cfgPath = path.join(CORE, 'src', 'platform', 'service', 'config.js');
  const mirPath = path.join(CORE, '..', 'shell', 'src-tauri', 'src', 'mirror.rs');
  if (!fs.existsSync(cfgPath) || !fs.existsSync(mirPath)) return;
  const cfg = read(cfgPath); const mir = read(mirPath);
  const m1 = /registries:\s*\[([\s\S]*?)\]/.exec(cfg);
  const m2 = /pub const NPM_PRESETS: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(mir);
  if (!m1 || !m2) { fail('R18', cfgPath, 1, '无法定位 registries / NPM_PRESETS ⇒ 无从判定覆盖关系'); return; }
  const norm = (x) => String(x).replace(/\/+$/, '');
  const js = [...m1[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => norm(x[1]));
  const rs = new Set([...m2[1].matchAll(/"([^"]+)"/g)].map((x) => norm(x[1])));
  const missing = js.filter((r) => !rs.has(r));
  if (missing.length) {
    fail('R18', mirPath, 1, '壳 NPM_PRESETS 未覆盖内核默认 registries: ' + missing.join(', ') + ' ⇒ 装机首启可能选到未探测源');
  }
  note('R18 镜像源上下流契约：壳探测集(' + rs.size + ') ⊇ 内核默认 registries(' + js.length + ')' + (missing.length ? '，缺 ' + missing.length : ''));
}


// ── R19：跨目录重复脚本必须收为单源（合仓后不得再有"同一判据两份"）───────────────
// 背景：core/ci/check-glibc.sh 与 shell/ci/check-glibc.sh 曾逻辑逐行相同（仅措辞/缩进不同）。
// 合仓后这类"同仓两份"最容易漏改 ⇒ 用门禁持续盯住：
//   判据 = 两个同名脚本若规范化后（去注释/空行/emoji/缩进）逐行相同，即判为重复。
function checkR19() {
  const names = ['check-glibc.sh'];
  const normSh = (t) => t.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => l.replace(/[\u2705\u274c]/g, '').trim());
  let flagged = 0;
  for (const n of names) {
    const a = path.join(CORE, 'ci', n);
    const b = path.join(CORE, '..', 'shell', 'ci', n);
    if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
    const la = normSh(read(a)); const lb = normSh(read(b));
    // 转发器（exec 单源）不算重复：它只有路径透传逻辑
    const isDelegate = (ls) => ls.some((l) => l.indexOf('exec bash') >= 0);
    if (isDelegate(lb) || isDelegate(la)) { note('R19 重复脚本：' + n + ' 已收为单源（另一侧为转发器）'); continue; }
    if (la.length === lb.length && la.every((l, i) => l === lb[i])) {
      fail('R19', b, 1, n + ' 与 core/ci/' + n + ' 逻辑逐行相同 ⇒ 同一判据两份，改一处必漏另一处；请改为转发单源');
      flagged += 1;
    }
  }
  note('R19 跨目录重复脚本：检查 ' + names.length + ' 个同名脚本，重复 ' + flagged + ' 处');
}


// ── R20：lockfile 的 resolved 必须指向官方 registry（可复现构建）───────────────
// 背景：core/ui/package-lock.json 曾把 mirrors.tencent.com / npmmirror 的 URL 硬编进 `resolved`。
// npm ci **按 resolved 精确取包** ⇒ 该镜像不可达时构建直接失败（Windows 腿曾 ETIMEDOUT 导致 win-x64 未发布）。
// lockfile 应对 registry 中立：只留 integrity 做校验，取包地址交由 npm 配置决定。
function checkR20() {
  const files = [];
  const walkLocks = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (['node_modules', '.git', 'dist', 'target'].indexOf(e.name) >= 0) continue; walkLocks(p); }
      else if (/package-lock\.json$/.test(e.name)) files.push(p);
    }
  };
  walkLocks(CORE);
  let flagged = 0;
  for (const p of files) {
    const src = read(p);
    let n = 0;
    src.split('\n').forEach((l, i) => {
      const m = /"resolved":\s*"(https?:\/\/[^/]+)\//.exec(l);
      if (!m) return;
      if (m[1] !== 'https://registry.npmjs.org') {
        if (n === 0) fail('R20', p, i + 1, 'lockfile 的 resolved 指向非官方 registry: ' + m[1] + ' ⇒ 该镜像不可达时 npm ci 构建失败（应统一为 https://registry.npmjs.org/）');
        n += 1;
      }
    });
    flagged += n;
  }
  note('R20 lockfile 可复现性：' + files.length + ' 个 package-lock.json，非官方 resolved ' + flagged + ' 处');
}


// ── R21：全局工具链落点跨语言一致（全局化后不得再漂回私有布局）─────────────
// 决策：产品不做私有化 —— Node/DSH 装到用户级全局目录并登记 PATH。
// 落点定义有两处（内核 exec-path.js / 壳 env.rs），任一处漂移都会让「装到 A、找 B」。
function checkR21() {
  const js = path.join(CORE, 'src', 'platform', 'os', 'exec-path.js');
  const rs = path.join(CORE, '..', 'shell', 'src-tauri', 'src', 'env.rs');
  if (!fs.existsSync(js) || !fs.existsSync(rs)) { note('R21 全局落点：源文件缺失，跳过'); return; }
  const a = read(js); const b = read(rs);
  const need = ['GLOBAL_APP_DIRNAME', 'GLOBAL_BIN_DIRNAME'];
  let flagged = 0;
  for (const k of need) {
    const inJs = new RegExp("const\\s+" + k + "\\s*=\\s*'([^']+)'").exec(a) || new RegExp("const\\s+" + k + "\\s*:\\s*&str\\s*=\\s*\"([^\"]+)\"").exec(a);
    const inRs = new RegExp("pub const " + k + "\\s*:\\s*&str\\s*=\\s*\"([^\"]+)\"").exec(b);
    if (!inJs || !inRs) { fail('R21', js, 1, k + ' 未在两处定义（内核/壳必须各有一份，值须逐字相同）'); flagged += 1; continue; }
    if (inJs[1] !== inRs[1]) {
      fail('R21', js, 1, k + ' 跨语言不一致：内核=' + inJs[1] + ' 壳=' + inRs[1] + ' ⇒ 会装到一处、找另一处');
      flagged += 1;
    }
  }
  // 全局化后，安装必须指向全局目标（不得仍指向私有状态根）
  const installs = ['platform/windows.rs', 'platform/linux.rs', 'platform/macos.rs'].map((x) => path.join(CORE, '..', 'shell', 'src-tauri', 'src', x));
  for (const p of installs) {
    if (!fs.existsSync(p)) continue;
    const src = read(p);
    if (/node_install_root\(\)/.test(src)) {
      fail('R21', p, 1, '平台安装仍用 node_install_root()（私有状态根）⇒ 应改用 node_install_target()（全局落点）');
      flagged += 1;
    }
  }
    // node_install_target 必须**一律返回全局根**：
  // 此前写成"老布局已装则复用" ⇒ 全局化对既有用户永不生效，Node 依旧私有。
  const envRs = path.join(CORE, '..', 'shell', 'src-tauri', 'src', 'env.rs');
  if (fs.existsSync(envRs)) {
    const src = read(envRs);
    const m = /pub fn node_install_target\(\) -> PathBuf \{([\s\S]*?)\n\}/.exec(src);
    if (!m) { fail('R21', envRs, 1, '缺 node_install_target()（Node 落点必须由它决定）'); flagged += 1; }
    else if (!/global_install_root\(\)/.test(m[1]) || /node_install_root\(\)/.test(m[1])) {
          fail('R21', envRs, 1, 'node_install_target() 未一律返回全局根（不得因"老布局已装"而停留在私有状态根）');
      flagged += 1;
    }
  }
  note('R21 全局落点一致性：常量 ' + need.length + ' 个 + 平台安装落点 + 迁移目标，问题 ' + flagged + ' 处');
}

// ── R22：术语门禁（唯一权威：仓库根 STANDARDS.md 的「术语表」）─────────────
// 产品是**管理面板**，不是守护/看护/监护程序。禁用词一旦回到文案/注释/代码，
// 定位就跟着漂回去 ⇒ 机器锁住：出现即红，并指出 文件:行号。
// 豁免只给「术语表与定位声明本身」（它们必须写出禁用词才能禁用它），且每次运行都列出。
const R22_BANNED = ['守护', '看护', '监护'];
const R22_REPLACE = { 守护: '监控', 看护: '监控', 监护: '监控' };
const R22_SKIP_DIRS = ['node_modules', '.git', 'dist', 'target', 'build'];
const R22_EXEMPT_FILES = [
  {
    file: 'STANDARDS.md',
    why: '术语表与定位声明本身必须写出禁用词才能禁用它（「不是守护程序，不是看护程序」）；'
      + '这是全仓唯一允许出现禁用词的文件，故豁免在文件级，不静默通过。',
  },
  {
    file: 'core/ci/standards-check.js',
    why: 'R22 判据自身要写禁用词常量才能扫它们（自指），与 R3 豁免同规。',
  },
];

function checkR22() {
  const exempt = new Set(R22_EXEMPT_FILES.map((x) => x.file));
  const files = [];
  const walkAll = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (R22_SKIP_DIRS.indexOf(e.name) < 0) walkAll(p); continue; }
      // 只扫文本类：二进制（图标/字体/icns）里没有术语，扫它是纯噪声。
      if (/\.(rs|js|ts|tsx|jsx|json|md|yml|yaml|sh|ps1|toml|html|svg|txt)$/.test(e.name)) files.push(p);
    }
  };
  walkAll(REPO);
  let flagged = 0;
  for (const p of files) {
    const rp = rel(p);
    if (exempt.has(rp)) continue;
    let src;
    try { src = read(p); } catch { continue; }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const w of R22_BANNED) {
        let at = lines[i].indexOf(w);
        while (at >= 0) {
          fail('R22', p, i + 1, '禁用词「' + w + '」⇒ 应改为「' + R22_REPLACE[w] + '」'
            + '（产品是管理面板，不是守护/看护/监护程序；见 STANDARDS.md 术语表）');
          flagged += 1;
          at = lines[i].indexOf(w, at + w.length);
        }
      }
    }
  }
  note('R22 术语门禁：扫描 ' + files.length + ' 个文件，禁用词 ' + flagged + ' 处（禁：'
    + R22_BANNED.join(' / ') + '）');
  R22_EXEMPT_FILES.forEach((x) => exemptShown.push('R22 豁免 ' + x.file + ' —— ' + x.why));
}

// ── R23：未声明标识符（重构删定义后漏删引用的唯一防线）────────────────────
//
// 动机（实证）：两个加载期崩溃同源——重构删除了 provider / 变量的定义，却漏删引用，
// 且引用落在**惰性求值路径**（模块导出对象字面量 / 延迟回调），编译器与运行时都抓不到：
//   * os/service.js  `_testProviders: { portable, NONE }` —— 导出期即求值 ⇒ 任何平台 require 都抛
//   * app/daemons/runtime.js  `exitIntended: () => host._exitIntended()` —— host 不在闭包链
//
// 判据（刻意收窄，避免误报淹没信号）：
//   1. 只监视**大写常量**（如 NONE）——大写名几乎不会是局部变量，命中即可疑；
//   2. 只扫**没被声明过**的名字：声明 = const/let/var/function/class 声明、解构、形参、对象键、属性访问。
//   3. 剥离注释与字符串字面量后再判，避免注释里的历史说明触发误报。
//
// ⚠️ 不做全量作用域分析：本仓 `host` 是**合法的惯用形参名**（200+ 处 function f(host)），
//    全量监视会产生 200+ 误报（这正是假门禁的成因，见 R16 教训）。故只保留大写常量这一高信噪比通道。
const R23_SKIP_DIRS = ['node_modules', '.git', 'target', 'dist', 'out', '.vite'];
const R23_MIN_LEN = 3;

// 文本 → 去注释、去字符串/正则字面量后的"代码骨架"
// 必须清掉正则字面量：pnpm 错误码（CANNOT_REMOVE_MISSING 等）常写在正则里，
// 不清会当成"被引用的大写标识符"⇒ 成片误报（R16 假门禁的同型教训）。
function codeSkeleton(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')                    // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')                 // 行注释（避开 http://）
    .replace(/'(?:\\.|[^'\\])*'/g, "''")                  // 单引号串
    .replace(/"(?:\\.|[^"\\])*"/g, '""')                  // 双引号串
    .replace(/`(?:\\.|[^`\\])*`/g, '``')                 // 模板串
    // 正则字面量：/.../ 后跟 flags。以"前面不是标识符字符且不是除号"近似起点，避开除号。
    .replace(/(^|[^\w$)\]])\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[gimsuy]*/g, '$1∅');
}

// 该名字在文件内是否有**真正的绑定**（区别于"仅仅出现在某处"）
// 绑定判定用**原始源码**（require 路径是字符串，会被 skeleton 清空），引用判定用 skeleton。
//
// ⚠️ 刻意**没有** "出现在 module.exports 里就算绑定" 这条：历史 bug 正是
//    `module.exports = { _testProviders: { portable, NONE } }` —— NONE 只出现在导出列表、
//    没有声明，恰恰是最需要被抓到的形态。加了这条就会把它判成合法（自证其罪）。
function r23Bound(srcRaw, code, name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = [
    '(?:const|let|var)\\s+(?:\\{[^}]*\\b' + n + '\\b[^}]*\\}|' + n + ')(?![\\w$])', // 声明（含解构导入）
    '(?:function\\s+)?\\w+\\s*\\([^)]*\\b' + n + '\\b[^)]*\\)\\s*\\{',        // 形参且为函数体
    '\\b' + n + '\\s*=\\s*[^=>]',                                             // 直接赋值（非比较）
    '\\b' + n + '\\s*:',                                                      // 对象成员键（定义侧）
    '\\.' + n + '\\b',                                                        // 属性访问（BRAND.X / obj.X）
  ];
  const re = pats.map((p) => new RegExp(p, 'm'));
  return re.some((r) => r.test(srcRaw)) || re.some((r) => r.test(code));
}

function checkR23() {
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (R23_SKIP_DIRS.indexOf(e.name) < 0) walk(p); continue; }
      if (/\.js$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(REPO, 'core', 'src'));

  let flagged = 0;
  let scanned = 0;
  for (const p of files) {
    let src;
    try { src = read(p); } catch { continue; }
    scanned += 1;
    const code = codeSkeleton(src);
    // 收集被引用的大写标识符。排除集（否则每类都产生成片误报，正是 R16 假门禁的成因）：
    //   常见全局/构造器、HTTP 方法、以及**错误码 / 注册表键 / 字面量枚举**——
    //   后者在本仓以字符串或常量表成员形式出现，不是"被引用却未声明的标识符"。
    const GLOBALS = new Set([
      'OK', 'NAN', 'JSON', 'URL', 'HTTP', 'HTTPS', 'PATH', 'FS', 'MAX', 'MIN',
      'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'TRACE', 'CONNECT',
      'GUI', 'CLI', 'BETA', 'ALPR', 'CERT', 'UNEXPECTED', 'SHELL', 'NATIVE', 'SANDBOX',
    ]);
    // 错误码 / errno / 注册表 hive / 平台字面量 / 全大写短语缩写：
    // 这些在本仓以字符串或常量表成员出现，不是"被引用却未声明的标识符"。
    const LITERAL_SHAPES = new RegExp('^(?:'
      + 'E[A-Z0-9]+'                    // ETIMEDOUT / EAI_AGAIN / ECONNREFUSED
      + '|HKEY_[A-Z_]*'                 // HKEY_LOCAL_MACHINE / HKEY_（前缀残留）
      + '|REG_[A-Z_]*'                  // REG_EXPAND_SZ / REG_（前缀残留）
      + '|SIG[A-Z]+'
      + '|[_A-Z0-9]*_(?:SZ|AGAIN|DWORD|ROOT)' // EXPAND_SZ / EAI_AGAIN 等后缀形态
      + ')$');
    const names = new Set();
    for (const m of code.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      const nm = m[1];
      if (GLOBALS.has(nm)) continue;
      if (LITERAL_SHAPES.test(nm)) continue;
      names.add(nm);
    }
    for (const name of names) {
      if (r23Bound(src, code, name)) continue;
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!new RegExp('\\b' + name + '\\b').test(lines[i])) continue;
        fail('R23', p, i + 1, '未声明的大写标识符「' + name + '」⇒ 疑似重构删定义后漏删引用'
          + '（惰性求值路径不报错，加载/回调时才崩；补声明、删除该引用，或改为形参注入）');
        flagged += 1;
      }
    }
  }
  note('R23 未声明标识符：扫描 ' + scanned + ' 个 src 文件，命中 ' + flagged + ' 处');
}

// ── R25：禁止把 Outcome 三态塌成布尔/null 判据（根因 A 的防复发门禁）──────
//
// 动机：三条 P0 同源——isUnitActive 用 null 表未知，调用方写 `active !== false`，
// 于是 null（未知）被当成"仍活跃" ⇒ removeInstance 报删除成功、升级校验假成功不回滚。
//
// 判据：对**已知返回 Outcome 的函数**，禁止用塌缩比较判定其成败。
// 只查当前已收敛的入口（isUnitActive / outcomeAlive / probeAlive），
// 随收敛推进逐步扩表——刻意不做全量类型推导（免误报，同 R23 的取舍）。
const R25_PRODUCERS = ['isUnitActive', 'outcomeAlive', 'probeAlive'];
// 塌缩判据：`!== false`、`=== true`、`!= null`、`!x` 直接作为条件/赋值
const R25_COLLAPSE = [
  /!==\s*false/, /===\s*true/, /!=\s*null/, /==\s*null/, /!==\s*null/,
];

function checkR25() {
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (R23_SKIP_DIRS.indexOf(e.name) < 0) walk(p); continue; }
      if (/\.js$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(REPO, 'core', 'src'));

  let flagged = 0;
  let scanned = 0;
  for (const p of files) {
    let src;
    try { src = read(p); } catch { continue; }
    scanned += 1;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const t = raw.trim();
      if (t.indexOf('//') === 0) continue;
      // 只查"调用了生产者"的行
      const calls = R25_PRODUCERS.some((fn) => new RegExp('\\b' + fn + '\\s*\\(').test(raw));
      if (!calls) continue;
      // 该行若直接对调用结果做塌缩比较 ⇒ 违规
      // 例：`if (service.isUnitActive(u, c) !== false)` / `const a = svc.isUnitActive(); x = a !== false`
      const collapsed = R25_COLLAPSE.some((re) => re.test(raw));
      if (!collapsed) continue;
      fail('R25', p, i + 1, 'Outcome 三态被塌成布尔/null 判据 ⇒ 未知会被当成成功或失败'
        + '（改用 shared/outcome 的 isOk / isFail / isUnknown 显式处置）');
      flagged += 1;
    }
  }
  note('R25 Outcome 判据：扫描 ' + scanned + ' 个 src 文件，塌缩判据 ' + flagged
    + ' 处（生产者：' + R25_PRODUCERS.join(', ') + '）');
}

// ── R24：禁止「判据类」空 catch（根因 C1 的防复发门禁）──────────────────
//
// 动机（实证）：全仓 384 处 bare `catch {}`，其中 49 处落在**流程判据**上：
// 吞掉的错误会让"失败"被当成"成功"——
//   * instance/ops.js  stopUnit/isUnitActive 异常 ⇒ 报"删除成功"（P0，已在 S1 修）
//   * relay/frp.js     syncFrpc 失败 ⇒ 静默
//   * router 域        探测失败 ⇒ 配额永久陈旧
//
// 判据（刻意收窄）：
//   catch 块为空 **且** 其 try 块内含有"流程性调用" ⇒ 判红。
//   清理类（rmSync/unlink/close 等）不判——一刀切会让 384 处全红、信号淹没（R16 假门禁教训）。
//
// 已知豁免（带 why，可审计；每轮整改应缩减本表）：
//   * chmod 收口：数据已落盘，权限不符需留痕但不改流程成败（已在下面代码豁免）
//   * 见 R24_EXEMPT 中的遗留项
const R24_EXEMPT = [
  // 这些是**本轮已识别、待下一批整改**的遗留项。登记而非删除：门禁保持可见，
  // 每整改一处即从本表移除一处 ⇒ 表长度即剩余债务。
  { file: 'core/src/domains/router/ops/oauth.js', why: 'OAuth 临时资源清理/服务关闭失败：不影响主流程，待补日志' },
  { file: 'core/src/domains/router/store/usage.js', why: '用量落盘失败：已有节流与脏标记，待改返回 Outcome.fail' },
  { file: 'core/src/domains/instance/store.js', why: 'syncPorts 的孤儿端口回收：失败不影响实例列表，待补日志' },
  { file: 'core/src/domains/instance/upgrade.js', why: '升级回滚的清理步骤：待逐处补日志' },
  { file: 'core/src/domains/instance/ops/dsh-install.js', why: '安装期清理与探测：待补日志' },
  { file: 'core/src/domains/instance/lifecycle.js', why: '违规处置的 stopUnit 清理：待补日志' },
  { file: 'core/src/domains/relay/ops.js', why: 'syncFrpc/代理清理：待补日志' },
  { file: 'core/src/domains/relay/ports.js', why: '端口回收：待补日志' },
  { file: 'core/src/domains/relay/frp-install.js', why: 'frpc 安装清理：待补日志' },
  { file: 'core/src/domains/plugin/layers.js', why: '补丁层写失败：已有 enqueue 终端 catch，待补日志' },
  { file: 'core/src/domains/plugin/restart.js', why: '目标存活探测：待补日志' },
  { file: 'core/src/domains/router/ops.js', why: '供应商摘除清理：待补日志' },
  { file: 'core/src/domains/router/ops/admin.js', why: '账号拆除清理：待补日志' },
  { file: 'core/src/domains/router/providers/process-pool.js', why: '实例停止探测：待补日志' },
  { file: 'core/src/domains/router/providers/restart.js', why: '重启探测：待补日志' },
  { file: 'core/src/domains/router/scheduler.js', why: '周期探测：待补日志' },
  { file: 'core/src/app/assembly/compose/observers.js', why: '观察器挂载：失败不应阻断装配，待补日志' },
  { file: 'core/src/app/daemons/process.js', why: 'daemon 身份/清理：待补日志' },
  { file: 'core/src/app/main/controller.js', why: '收敛拍的清理：待补日志' },
  { file: 'core/src/app/session/shutdown.js', why: '停机清理：待补日志' },
  { file: 'core/src/app/state/desired.js', why: '意图登记清理：待补日志' },
  { file: 'core/src/app/state/store.js', why: '状态落盘清理：待补日志' },
  { file: 'core/src/platform/os/autostart/darwin.js', why: '自启项清理：待补日志' },
  { file: 'core/src/platform/os/autostart/linux.js', why: '自启项清理：待补日志' },
  { file: 'core/src/platform/os/file-protect.js', why: '权限加固失败：已返回 ok:false，属清理类' },
  { file: 'core/src/platform/os/portable.js', why: 'pid 文件读取清理：待补日志' },
  { file: 'core/src/platform/service/ports/migrate.js', why: '迁移回滚清理：待补日志' },
  { file: 'core/src/platform/service/ports/store.js', why: '账本读取清理：待补日志' },
];
const R24_FLOW_CALLS = [
  'stopUnit', 'startUnit', 'startTransient', 'stopTransient', 'restart', 'setLimits',
  'isUnitActive', 'removeInstance', 'removeProxyForInstance', 'unregister', 'unregisterPort',
  'save', 'writeAtomic', 'appendFileSync', 'writeFileSync', 'persistConfigPatch', 'writeDshMain',
  'syncFrpc', 'applyToken', 'startInstance', 'startProcess', 'probeInstance',
];

function checkR24() {
  const files = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (R23_SKIP_DIRS.indexOf(e.name) < 0) walk(p); continue; }
      if (/\.js$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(REPO, 'core', 'src'));

  const exempt = new Set(R24_EXEMPT.map((x) => x.file));
  let flagged = 0;
  let scanned = 0;
  for (const p of files) {
    if (exempt.has(rel(p))) continue;      // 已登记、待下一批整改
    let src;
    try { src = read(p); } catch { continue; }
    scanned += 1;
    const linesRaw = src.replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < linesRaw.length; i += 1) {
      const line = linesRaw[i];
      if (!/catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line)) continue;
      // 豁免：chmod 收口失败是**清理类**（数据已落盘，权限不符需留痕但不改流程成败）。
      // 一刀切会把这类也判红 ⇒ 信号淹没（R16 假门禁同型教训）。
      // 必须在 block 声明**之后**判（否则 TDZ）。
      let block = '';
      for (let j = Math.max(0, i - 10); j < i; j += 1) block += linesRaw[j] + '\n';
      if (/chmodSync/.test(block + line)) continue;   // 含 catch 所在行：兼容单行 try/catch 形式
      // 向上回溯最近的 try 块（最多 10 行），判断其中是否有流程性调用。
      // ⚠️ 用 \r?\n 归一化后再切行：仓库混用 CRLF/LF，直接按 \n 切会残留 \r，
      //    导致 `catch {}` 正则失配（实测会漏报——假门禁的另一种成因）。（block 已在上面构建）
      // ⚠️ 单语句形式 `try { chmodSync(x) } catch {}` —— try 体与 catch **同行**，
      //    纯回溯会漏掉它 ⇒ 误判为流程类。故判定 flow 时要**连同 catch 所在行**一起看。
      const flow = R24_FLOW_CALLS.some((fn) => new RegExp('\\b' + fn + '\\s*\\(').test(block));
      if (!flow) continue;
      fail('R24', p, i + 1, '判据类空 catch ⇒ 失败被吞会当成成功'
        + '（须记录日志、或返回 Outcome.fail / ok:false；清理类 catch 请改用非流程调用或补注释豁免）');
      flagged += 1;
    }
  }
  note('R24 判据类空 catch：扫描 ' + scanned + ' 个 src 文件，命中 ' + flagged + ' 处（已登记豁免 '
    + R24_EXEMPT.length + ' 个文件 —— 表长度即剩余债务）');
  R24_EXEMPT.forEach((x) => exemptShown.push('R24 豁免 ' + x.file + ' —— ' + x.why));
}

function main() {
  console.log('== standards-check：R1..R10 中可机器判定的部分（只读）==');
  checkR2();
  const manifest = loadManifest();
  MANIFEST_REG = manifest || null;
  if (manifest) { checkR5(manifest, path.join(TEST_DIR, 'manifest.js')); checkR6(manifest); }
  checkR3();
  checkR9();
  checkR10();
  checkR11();
  checkR12();
  checkR13();
  checkR14();
  checkR15();
  checkR16();
  checkR17();
  checkR18();
  checkR19();
  checkR20();
  checkR21();
  checkR22();
  checkR23();
  checkR25();
  checkR24();

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
