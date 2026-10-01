#!/usr/bin/env node
'use strict';

// 跨语言品牌单源对账：解析 `shell/src-tauri/src/brand.rs` 的 `pub const`，逐个断言与 `core/src/shared/brand.js`
//   值相等，并断言两边的**常量名集合相同** —— 任何一边单独改动都会在这里判红。
// 另有一份**冻结字面量** EXPECT/RULES：单源两侧被同时改错时它与单源比对仍会失败（不拿同一个源证明自己）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const JS_PATH = path.join(ROOT, 'src', 'shared', 'brand.js');
const RS_PATH = path.join(ROOT, '..', 'shell', 'src-tauri', 'src', 'brand.rs');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

// ── brand.rs 解析 ────────────────────────────────────────────────────────────
function unescapeRust(s) {
  return s.replace(/\\(.)/g, (m, c) => {
    if (c === 'n') return String.fromCharCode(10);
    if (c === 't') return String.fromCharCode(9);
    if (c === 'r') return String.fromCharCode(13);
    if (c === '\\') return '\\';
    if (c === '"') return '"';
    if (c === "'") return "'";
    return c;
  });
}

function parseRustValue(expr) {
  const e = expr.trim();
  if (e.startsWith('&[') && e.endsWith(']')) {
    const inner = e.slice(2, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((p) => {
      const t = p.trim();
      const m = /^"(.*)"$/.exec(t);
      if (!m) throw new Error('非字符串数组元素: ' + t);
      return unescapeRust(m[1]);
    });
  }
  const m = /^"(.*)"$/.exec(e);
  if (!m) throw new Error('无法解析的常量表达式: ' + e);
  return unescapeRust(m[1]);
}

function parseRust() {
  const src = fs.readFileSync(RS_PATH, 'utf8');
  const out = new Map();
  const dup = [];
  const re = /^pub const ([A-Z][A-Z0-9_]*)\s*:\s*([^=]+?)\s*=\s*(.+);\s*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    if (out.has(name)) dup.push(name);
    out.set(name, parseRustValue(m[3]));
  }
  return { out, dup, src };
}

function parseJsConstNames() {
  const src = fs.readFileSync(JS_PATH, 'utf8');
  const names = [];
  const re = /^const ([A-Z][A-Z0-9_]*) = /gm;
  let m;
  while ((m = re.exec(src)) !== null) names.push(m[1]);
  return names;
}

const rust = parseRust();
const BRAND = require(JS_PATH);
const jsNames = parseJsConstNames();
const jsExportedUpper = Object.keys(BRAND).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)).sort();
const rustNames = Array.from(rust.out.keys()).sort();
const jsSorted = jsNames.slice().sort();

// ── A. 常量名集合相同（防只改一边）──────────────────────────────────────────
{
  const onlyJs = jsSorted.filter((n) => !rust.out.has(n));
  const onlyRs = rustNames.filter((n) => jsSorted.indexOf(n) < 0);
  check('A-1 两边常量名集合相同（brand.js ↔ brand.rs）',
    onlyJs.length === 0 && onlyRs.length === 0 && jsSorted.length > 0,
    'js=' + jsSorted.length + ' rs=' + rustNames.length
      + (onlyJs.length ? ' 仅 JS: ' + onlyJs.join(',') : '')
      + (onlyRs.length ? ' 仅 RS: ' + onlyRs.join(',') : ''));
  check('A-2 brand.js 无重复常量名', new Set(jsSorted).size === jsSorted.length,
    'declared=' + jsSorted.length + ' unique=' + new Set(jsSorted).size);
  check('A-3 brand.rs 无重复常量名', rust.dup.length === 0, rust.dup.join(','));
  check('A-4 brand.js 声明的每个常量都已导出', jsSorted.every((n) => BRAND[n] !== undefined),
    jsSorted.filter((n) => BRAND[n] === undefined).join(','));
  check('A-5 brand.js 导出的 UPPER_SNAKE 与声明的常量一一对应',
    jsExportedUpper.length === jsSorted.length && jsExportedUpper.every((n, i) => n === jsSorted[i]),
    'exported=' + jsExportedUpper.length);
}

// ── B. 逐值相等 ─────────────────────────────────────────────────────────────
{
  const bad = [];
  for (const name of jsSorted) {
    if (!rust.out.has(name)) continue;
    const a = BRAND[name];
    const b = rust.out.get(name);
    const eq = Array.isArray(a) || Array.isArray(b)
      ? Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
      : a === b;
    if (!eq) bad.push(name + ' js=' + JSON.stringify(a) + ' rs=' + JSON.stringify(b));
  }
  check('B-1 每个同名常量的值逐字相等', bad.length === 0, bad.join(' | '));
  check('B-2 字符串常量无一含有未转义的占位标记（模板除外）',
    jsSorted.every((n) => typeof BRAND[n] !== 'string' || BRAND[n].indexOf('\u0000') < 0), 'ok');
}

// ── C. 冻结字面量：对外可见名字必须等于现状值 ───────────────────────────────
const EXPECT = {
  PRODUCT_NAME: 'lobox',
  CLI_NAME: 'lobox',
  GUI_BIN_NAME: 'lobox-shell',
  GUI_CRATE_NAME: 'lobox-shell',
  NPM_SCOPE: '@lob-ox',
  CORE_PKG_PREFIX: 'core-',
  SHELL_RELEASE_PKG: '@lob-ox/shell-release',
  TAURI_IDENTIFIER: 'dev.bowen.lobox',
  TAURI_PRODUCT_NAME: 'lobox',
  STATE_DIR_NAME: 'lobox',
  STATE_SUPERVISOR_SUBDIR: 'supervisor',
  STATE_SHELL_SUBDIR: 'shell',
  LEGACY_PRODUCT_NAME: 'dsh-supervisor',
  STATE_ROOT_WIN_BASE_ENV: 'LOCALAPPDATA',
  STATE_ROOT_LINUX_XDG_ENV: 'XDG_STATE_HOME',
  LEGACY_HARNESS_DIR: '.dsh',
  ENV_STATE_ROOT: 'DSH_SUPERVISOR_HOME',
  WINDOWS_GUARD_TASK: 'Lobox',
  WINDOWS_WATCHDOG_TASK: 'Lobox-Watchdog',
  WINDOWS_GUI_TASK: 'Lobox-Shell',
  WINDOWS_RUN_VALUE: 'Lobox',
  SYSTEMD_UNIT_NAME: 'lobox',
  SYSTEMD_UNIT_FILE: 'lobox.service',
  SEA_BUNDLE_NAME: 'core.cjs',
  SEA_VERSION_DEFINE: '__DSH_VERSION__',
  PROC_MATCH_GUARD: '*lobox*',
  PROC_MATCH_GUI: 'lobox-shell',
};
{
  const bad = [];
  for (const [name, want] of Object.entries(EXPECT)) {
    if (BRAND[name] !== want) bad.push(name + '=' + JSON.stringify(BRAND[name]) + ' ≠ ' + JSON.stringify(want));
  }
  check('C-1 对外可见名字等于冻结的现状值（' + Object.keys(EXPECT).length + ' 项）', bad.length === 0, bad.join(' | '));
  check('C-2 四平台子包标签与 core/package.json 的清单一致',
    JSON.stringify(BRAND.CORE_PKG_TAGS) === JSON.stringify(['linux-x64', 'darwin-arm64', 'darwin-x64', 'win-x64'])
      && BRAND.CORE_PKG_TAGS.every((t) => BRAND.corePackageName(t) === '@lob-ox/core-' + t),
    JSON.stringify(BRAND.CORE_PKG_TAGS));
  check('C-3 三平台状态根分支原料与冻结值一致',
    JSON.stringify(BRAND.STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS) === JSON.stringify(['AppData', 'Local'])
      && JSON.stringify(BRAND.STATE_ROOT_MACOS_SEGMENTS) === JSON.stringify(['Library', 'Application Support'])
      && JSON.stringify(BRAND.STATE_ROOT_LINUX_FALLBACK_SEGMENTS) === JSON.stringify(['.local', 'state']),
    JSON.stringify([BRAND.STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS, BRAND.STATE_ROOT_MACOS_SEGMENTS, BRAND.STATE_ROOT_LINUX_FALLBACK_SEGMENTS]));
}

// ── D. 状态根推导规则（三平台，用冻结字面量判）──────────────────────────────
const HOME = path.join('H', 'ome');
{
  const cases = [
    ['win32 有 LOCALAPPDATA', BRAND.stateRoot('win32', { LOCALAPPDATA: 'L' }, HOME), path.join('L', 'lobox')],
    ['win32 无 LOCALAPPDATA 回落家目录', BRAND.stateRoot('win32', {}, HOME), path.join(HOME, 'AppData', 'Local', 'lobox')],
    ['darwin 恒为 Application Support', BRAND.stateRoot('darwin', {}, HOME), path.join(HOME, 'Library', 'Application Support', 'lobox')],
    ['linux 有 XDG_STATE_HOME', BRAND.stateRoot('linux', { XDG_STATE_HOME: 'X' }, HOME), path.join('X', 'lobox')],
    ['linux 无 XDG 回落 ~/.local/state', BRAND.stateRoot('linux', {}, HOME), path.join(HOME, '.local', 'state', 'lobox')],
  ];
  const bad = cases.filter((c) => c[1] !== c[2]).map((c) => c[0] + ': ' + c[1] + ' ≠ ' + c[2]);
  check('D-1 状态根平台分支逐字正确', bad.length === 0, bad.join(' | '));
}

// ── E. 消费点：state-root.js 的 override 与子目录 ──────────────────────────
// 三方对账链条（每一环都用**独立预言字面量**，任何一环单独漂移都判红）：
//   D-1：单源规则 brand.stateRoot ↔ 冻结字面量；E-4/E-5：消费点 sr.root() ↔ 同一批冻结字面量
//   ⇒ 消费点与单源规则一致。**不拿单源算一遍再和单源比**（那是自证，见 platform-matrix-single-source-test.js:33）。
// 覆盖位的前提必须**显式建立**：官方跑法 `test/_runner.js` 用 `-r ./test/_preload.js` 起每个测试进程，
//   而 _preload.js 会注入 DSH_SUPERVISOR_HOME=<mkdtemp 'dsh-test-'>；所以「环境里恰好没有覆盖位」
//   只在裸跑 `node test/brand-single-source-test.js` 时成立 —— 靠这个巧合的断言在 CI 上必红。
{
  const sr = require(path.join(ROOT, 'src', 'platform', 'service', 'state-root.js'));
  const saved = process.env[BRAND.ENV_STATE_ROOT];
  const probe = path.join(os.tmpdir(), 'dsh-brand-root-probe');
  process.env[BRAND.ENV_STATE_ROOT] = probe;
  const overridden = sr.root();
  const sup = sr.supervisorDir();
  const shl = sr.shellDir();
  check('E-1 覆盖位优先且绝对化', overridden === path.resolve(probe), overridden);
  check('E-2 supervisorDir = <根>/supervisor', sup === path.join(overridden, 'supervisor'), sup);
  check('E-3 shellDir = <根>/shell', shl === path.join(overridden, 'shell'), shl);

  // 家目录/基座用注入的冻结字面量，避免断言结果随宿主环境漂移；覆盖位在本段内一律不存在（finally 恢复）。
  const FROZEN_HOME = path.join('H', 'ome');
  const ENV_NAMES = ['HOME', 'USERPROFILE', BRAND.STATE_ROOT_WIN_BASE_ENV, BRAND.STATE_ROOT_LINUX_XDG_ENV];
  const savedEnv = {};
  for (const name of ENV_NAMES) savedEnv[name] = process.env[name];
  try {
    process.env.HOME = FROZEN_HOME;
    process.env.USERPROFILE = FROZEN_HOME; // Windows 的 os.homedir() 只认 USERPROFILE（不认 HOME）
    delete process.env[BRAND.STATE_ROOT_WIN_BASE_ENV];
    delete process.env[BRAND.STATE_ROOT_LINUX_XDG_ENV];
    delete process.env[BRAND.ENV_STATE_ROOT]; // ← 前提「无覆盖位」在此显式成立（CI 注入的临时根必须被移除）

    // E-4 宿主平台（真实进程，不注入 platform）：基座缺失的回落分支 + 有基座时另一平台变量当诱饵，期望值都是冻结字面量。
    const DECOY_WIN = path.join('D', 'ecoyWin');
    const DECOY_XDG = path.join('D', 'ecoyXdg');
    const HOST_CASES = process.platform === 'win32'
      ? [
        ['win32 基座缺失回落家目录', {}, path.join(FROZEN_HOME, 'AppData', 'Local', 'lobox')],
        ['win32 有 LOCALAPPDATA（XDG 为诱饵，不得串台）', { LOCALAPPDATA: path.join('W', 'in'), XDG_STATE_HOME: DECOY_XDG }, path.join('W', 'in', 'lobox')],
      ]
      : process.platform === 'darwin'
        ? [
          ['darwin 恒为 Application Support', {}, path.join(FROZEN_HOME, 'Library', 'Application Support', 'lobox')],
          ['darwin 下 LOCALAPPDATA/XDG 皆为诱饵（不得串台）', { LOCALAPPDATA: DECOY_WIN, XDG_STATE_HOME: DECOY_XDG }, path.join(FROZEN_HOME, 'Library', 'Application Support', 'lobox')],
        ]
        : [
          ['linux 基座缺失回落 ~/.local/state', {}, path.join(FROZEN_HOME, '.local', 'state', 'lobox')],
          ['linux 有 XDG_STATE_HOME（LOCALAPPDATA 为诱饵，不得串台）', { XDG_STATE_HOME: path.join('X', 'dg'), LOCALAPPDATA: DECOY_WIN }, path.join('X', 'dg', 'lobox')],
        ];
    const hostBad = [];
    const hostSeen = [];
    for (const [label, base, want] of HOST_CASES) {
      delete process.env[BRAND.STATE_ROOT_WIN_BASE_ENV];
      delete process.env[BRAND.STATE_ROOT_LINUX_XDG_ENV];
      Object.assign(process.env, base);
      const got = sr.root();
      hostSeen.push(label + '=' + got);
      if (got !== want) hostBad.push(label + ': ' + got + ' ≠ ' + want);
    }
    check('E-4 无覆盖位时宿主平台状态根逐条对冻结字面量（不拿单源自证）',
      hostBad.length === 0, (hostBad.length ? hostBad.join(' | ') + '  ||  ' : '') + hostSeen.join('  '));

    // E-5 四平台状态根语义（win-x64 / linux-x64 / darwin-arm64 / darwin-x64；darwin 两 tag 同一分支）：
    //   子进程注入 process.platform，覆盖位在子进程 env 里同样**显式删除**；期望值逐条独立写出，
    //   并给「不属于该平台」的基座变量注入诱饵，钉住三平台分支互不串台。
    const CASES = [
      ['win32 有 LOCALAPPDATA', 'win32', { LOCALAPPDATA: path.join('L', 'ocal'), XDG_STATE_HOME: DECOY_XDG }, path.join('L', 'ocal', 'lobox')],
      ['win32 基座缺失回落家目录', 'win32', {}, path.join(FROZEN_HOME, 'AppData', 'Local', 'lobox')],
      ['darwin 恒为 Application Support', 'darwin', {}, path.join(FROZEN_HOME, 'Library', 'Application Support', 'lobox')],
      ['darwin 下两平台基座皆为诱饵', 'darwin', { LOCALAPPDATA: DECOY_WIN, XDG_STATE_HOME: DECOY_XDG }, path.join(FROZEN_HOME, 'Library', 'Application Support', 'lobox')],
      ['linux 有 XDG_STATE_HOME', 'linux', { XDG_STATE_HOME: path.join('X', 'dg'), LOCALAPPDATA: DECOY_WIN }, path.join('X', 'dg', 'lobox')],
      ['linux 基座缺失回落 ~/.local/state', 'linux', {}, path.join(FROZEN_HOME, '.local', 'state', 'lobox')],
    ];
    const SR_PATH = path.join(ROOT, 'src', 'platform', 'service', 'state-root.js');
    const bad = [];
    const seen = [];
    for (const [label, platform, base, want] of CASES) {
      const env = Object.assign({}, process.env, { HOME: FROZEN_HOME, USERPROFILE: FROZEN_HOME });
      delete env[BRAND.ENV_STATE_ROOT];
      delete env[BRAND.STATE_ROOT_WIN_BASE_ENV];
      delete env[BRAND.STATE_ROOT_LINUX_XDG_ENV];
      Object.assign(env, base);
      const code = "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });"
        + "process.stdout.write(require(" + JSON.stringify(SR_PATH) + ").root());";
      let got;
      try {
        got = execFileSync(process.execPath, ['-e', code], { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 }).trim();
      } catch (e) { got = 'EXECFAIL:' + ((e && e.message) || e); }
      seen.push(platform + (Object.keys(base).length ? '有基座' : '无基座') + '=' + got);
      if (got !== want) bad.push(label + ': ' + got + ' ≠ ' + want);
    }
    check('E-5 覆盖位缺席时四平台状态根语义逐条对冻结字面量', bad.length === 0,
      (bad.length ? bad.join(' | ') + '  ||  ' : '') + seen.join('  '));
  } finally {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    // 覆盖位恢复到本块开始前的样子（savedEnv 是在把它设成 probe **之后**采样的，故单列恢复）。
    if (saved === undefined) delete process.env[BRAND.ENV_STATE_ROOT];
    else process.env[BRAND.ENV_STATE_ROOT] = saved;
  }
}

// ── F. brand.rs 的状态根规则函数存在（跨语言规则的两端都在）────────────────
{
  const fns = ['state_root_windows', 'state_root_macos', 'state_root_linux', 'home_join'];
  const missing = fns.filter((f) => rust.src.indexOf('fn ' + f + '(') < 0);
  check('F-1 brand.rs 声明了三平台状态根规则函数', missing.length === 0, missing.join(','));
  check('F-2 brand.rs 的规则函数引用单源常量而非手写字面量',
    ['STATE_DIR_NAME', 'STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS', 'STATE_ROOT_MACOS_SEGMENTS', 'STATE_ROOT_LINUX_FALLBACK_SEGMENTS']
      .every((n) => rust.src.indexOf(n + ')') >= 0 || rust.src.indexOf(n + '.') >= 0 || rust.src.indexOf('join(' + n) >= 0),
    'ok');
}

// ── G. 归一化边界：两侧行为逐条一致（纯空白 = 未设置 ⇒ 回落）─────────────────
// 本段要防的正是 B-1 漏掉的那一类缺陷：B-1 只比**常量值**，不比规则在边界输入上的**行为** ——
//   波 0 的单源里 brand.js(win32) 用 `||`（纯空白不回落）、brand.js(linux) 内联 trim（回落）、
//   brand.rs(win32) 用 `.filter(|s| !s.trim().is_empty())`（回落）、brand.rs(linux) 只查 `is_empty()`
//   （不回落）：同一个「LOCALAPPDATA/XDG_STATE_HOME 为纯空白」的输入，两侧两条相反路径，B-1 却全绿。
// 做法（不编译 Rust，也不拿单源自证）：
//   ① 冻结字面量表 GCASES：每条期望路径由冻结段字面量独立拼出，与两侧实现无关；
//   ② G-1：JS 侧实跑 BRAND.stateRoot(...) ↔ 冻结期望；
//   ③ G-2：Rust 侧按 brand.rs **源码逐字提取**的语义位求值 ↔ 同一批冻结期望 ——
//      「是否 trim 值 / 空白判定是否 trim / 两分支是否接上归一化入口」四个位全部从源码读出，不写死；
//   ④ G-3：两侧逐条互比；G-4/G-5/G-6：覆盖矩阵与「实现逐字等于冻结字面量」的结构对账。
//   ⇒ 任一侧单独改错 ⇒ 至少 G-1 或 G-2 变红。
{
  const GH = path.join('G', 'home'); // G 段自己的冻结家目录字面量
  const WIN_FB = path.join(GH, 'AppData', 'Local', 'lobox');
  const MAC = path.join(GH, 'Library', 'Application Support', 'lobox');
  const LNX_FB = path.join(GH, '.local', 'state', 'lobox');
  const WIN_KEY = 'LOCALAPPDATA';
  const XDG_KEY = 'XDG_STATE_HOME';
  const WS = [['空串', ''], ['纯空格', '   '], ['制表符', '\t'], ['换行', '\n'], ['回车换行', '\r\n']];
  const HOME_WS = ['   ', '\t', '\n'];

  const GCASES = [];
  const push = (label, platform, env, home, want) => GCASES.push({ label, platform, env, home, want });

  // (1) LOCALAPPDATA 纯空白（win32）⇒ 必须回落 <家>/AppData/Local/lobox
  for (const [n, v] of WS) push('win32 ' + WIN_KEY + '=' + n + ' ⇒ 回落家目录', 'win32', { [WIN_KEY]: v }, GH, WIN_FB);
  // (2) 未设置基线（键不存在 / 显式 undefined）
  push('win32 ' + WIN_KEY + ' 键不存在 ⇒ 回落家目录', 'win32', {}, GH, WIN_FB);
  push('win32 ' + WIN_KEY + '=undefined ⇒ 回落家目录', 'win32', { [WIN_KEY]: undefined }, GH, WIN_FB);
  // (3) 正常值 / 两侧空白包裹（空白包裹必须取 trim 后的值）
  push('win32 ' + WIN_KEY + '=WinBase（正常值）', 'win32', { [WIN_KEY]: 'WinBase' }, GH, path.join('WinBase', 'lobox'));
  push('win32 ' + WIN_KEY + ' 两侧空白包裹 ⇒ 取 trim 后值', 'win32', { [WIN_KEY]: '  WinBase  ' }, GH, path.join('WinBase', 'lobox'));
  // (4) 诱饵：win32 不看 XDG
  push('win32 ' + XDG_KEY + ' 正常值（诱饵）不得串台', 'win32', { [XDG_KEY]: 'XdgBase' }, GH, WIN_FB);
  push('win32 ' + XDG_KEY + ' 纯空白（诱饵）不得串台', 'win32', { [XDG_KEY]: '   ' }, GH, WIN_FB);
  // (5) darwin：无基座，两个基座变量都不得参与
  push('darwin 无基座 ⇒ Application Support', 'darwin', {}, GH, MAC);
  push('darwin 两平台基座纯空白（诱饵）⇒ Application Support', 'darwin', { [WIN_KEY]: '   ', [XDG_KEY]: '\t' }, GH, MAC);
  push('darwin 两平台基座正常值（诱饵）⇒ Application Support', 'darwin', { [WIN_KEY]: 'WinBase', [XDG_KEY]: 'XdgBase' }, GH, MAC);
  // (6) XDG_STATE_HOME 纯空白（linux）⇒ 必须回落 <家>/.local/state/lobox
  for (const [n, v] of WS) push('linux ' + XDG_KEY + '=' + n + ' ⇒ 回落 ~/.local/state', 'linux', { [XDG_KEY]: v }, GH, LNX_FB);
  // (7) 未设置基线 / 正常值 / 空白包裹 / 诱饵
  push('linux ' + XDG_KEY + ' 键不存在 ⇒ 回落 ~/.local/state', 'linux', {}, GH, LNX_FB);
  push('linux ' + XDG_KEY + '=undefined ⇒ 回落 ~/.local/state', 'linux', { [XDG_KEY]: undefined }, GH, LNX_FB);
  push('linux ' + XDG_KEY + '=XdgBase（正常值）', 'linux', { [XDG_KEY]: 'XdgBase' }, GH, path.join('XdgBase', 'lobox'));
  push('linux ' + XDG_KEY + ' 两侧空白包裹 ⇒ 取 trim 后值', 'linux', { [XDG_KEY]: '  XdgBase  ' }, GH, path.join('XdgBase', 'lobox'));
  push('linux ' + WIN_KEY + ' 正常值（诱饵）不得串台', 'linux', { [WIN_KEY]: 'WinBase' }, GH, LNX_FB);
  push('linux ' + WIN_KEY + ' 纯空白（诱饵）不得串台', 'linux', { [WIN_KEY]: '   ' }, GH, LNX_FB);
  // (8) 家目录纯空白：`home` 是**调用方给出的参数**，不是被归一化的基座环境变量（本单源不归一化它）——
  //     这里断言两侧**同样**不归一化 home（两侧一致），冻结期望就是「空白家目录 + 各平台回落段」的拼接。
  for (const v of HOME_WS) {
    const tag = '家目录=' + JSON.stringify(v) + '（两侧同样不归一化 home）';
    push('win32 ' + tag, 'win32', {}, v, path.join(v, 'AppData', 'Local', 'lobox'));
    push('darwin ' + tag, 'darwin', {}, v, path.join(v, 'Library', 'Application Support', 'lobox'));
    push('linux ' + tag, 'linux', {}, v, path.join(v, '.local', 'state', 'lobox'));
  }

  // ① Rust 侧：从 brand.rs 源码逐字提取语义位（不编译；CI 的 cargo test 兜底）
  const rustFnBody = (src, name) => {
    const at = src.indexOf('fn ' + name + '(');
    if (at < 0) return '';
    const rest = src.slice(at);
    const end = rest.search(/\n\}\n/);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const RS_ENV_BASE_LINE = (rustFnBody(rust.src, 'env_base').split('\n').find((l) => l.indexOf('.map(') >= 0) || '').trim();
  const RS_VALUE_TRIMMED = /\.map\(\|s\|\s*s\.trim\(\)\.to_string\(\)\)/.test(RS_ENV_BASE_LINE);
  const RS_BLANK_TRIMMED = /\.filter\(\|s\|\s*!s\.trim\(\)\.is_empty\(\)\)/.test(RS_ENV_BASE_LINE);
  const RS_BLANK_EMPTY_ONLY = /\.filter\(\|s\|\s*!s\.is_empty\(\)\)/.test(RS_ENV_BASE_LINE);
  const RS_WIN_BODY = rustFnBody(rust.src, 'state_root_windows');
  const RS_LINUX_BODY = rustFnBody(rust.src, 'state_root_linux');
  const RS_WIN_WIRED = /env_base\(\s*local_appdata\s*\)/.test(RS_WIN_BODY);
  const RS_LINUX_WIRED = /env_base_os\(\s*xdg_state_home\s*\)/.test(RS_LINUX_BODY);

  // ② 按提取到的规则求值（语义与 brand.rs::env_base + env_base_os + 两个分支函数一一对应）
  const rsEnvBase = (v, wired) => {
    if (v === undefined || v === null) return null;
    let s = String(v);
    if (!wired) return s; // 分支没接上归一化入口 ⇒ 原样取值（空白不回落）
    if (RS_VALUE_TRIMMED) s = s.trim();
    const keep = RS_BLANK_TRIMMED ? s.trim() !== '' : (RS_BLANK_EMPTY_ONLY ? s !== '' : true);
    return keep ? s : null;
  };
  const rsStateRoot = (platform, env, home) => {
    const get = (k) => (Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined);
    if (platform === 'win32') {
      return path.join(rsEnvBase(get(WIN_KEY), RS_WIN_WIRED) || path.join(home, 'AppData', 'Local'), 'lobox');
    }
    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'lobox');
    }
    return path.join(rsEnvBase(get(XDG_KEY), RS_LINUX_WIRED) || path.join(home, '.local', 'state'), 'lobox');
  };

  // ③ 三向对账：JS ↔ 冻结期望，Rust 规则 ↔ 同一冻结期望，JS ↔ Rust
  const badJs = [];
  const badRs = [];
  const badPair = [];
  for (const c of GCASES) {
    const js = BRAND.stateRoot(c.platform, c.env, c.home);
    const rs = rsStateRoot(c.platform, c.env, c.home);
    if (js !== c.want) badJs.push(c.label + ': js=' + JSON.stringify(js) + ' ≠ ' + JSON.stringify(c.want));
    if (rs !== c.want) badRs.push(c.label + ': rs=' + JSON.stringify(rs) + ' ≠ ' + JSON.stringify(c.want));
    if (js !== rs) badPair.push(c.label + ': js=' + JSON.stringify(js) + ' ≠ rs=' + JSON.stringify(rs));
  }
  const N = GCASES.length;
  check('G-1 边界输入 JS 侧（BRAND.stateRoot）逐条等于冻结字面量（' + N + ' 条）', badJs.length === 0, badJs.join(' | '));
  check('G-2 边界输入 Rust 侧（brand.rs 源码提取的归一化规则）逐条等于同一批冻结字面量', badRs.length === 0, badRs.join(' | '));
  check('G-3 两侧逐条行为一致（JS ↔ Rust 同一条归一化规则）', badPair.length === 0, badPair.join(' | '));

  // ④ 覆盖矩阵（案数冻结，防删条目后静默变绿）
  const has = (f) => GCASES.some(f);
  const WS3 = ['   ', '\t', '\n'];
  const cover = {
    '案数=34': N === 34,
    'LOCALAPPDATA 三种纯空白': WS3.every((v) => has((c) => c.platform === 'win32' && Object.is(c.env[WIN_KEY], v))),
    'XDG_STATE_HOME 三种纯空白': WS3.every((v) => has((c) => c.platform === 'linux' && Object.is(c.env[XDG_KEY], v))),
    'HOME 三种纯空白 × 三平台': HOME_WS.every((v) => ['win32', 'darwin', 'linux'].every((p) => has((c) => c.platform === p && c.home === v))),
    '未设置基线：键不存在': has((c) => c.platform === 'win32' && !(WIN_KEY in c.env)) && has((c) => c.platform === 'linux' && !(XDG_KEY in c.env)),
    '未设置基线：undefined': has((c) => c.platform === 'win32' && c.env[WIN_KEY] === undefined && WIN_KEY in c.env)
      && has((c) => c.platform === 'linux' && c.env[XDG_KEY] === undefined && XDG_KEY in c.env),
    'win32 有基座': has((c) => c.platform === 'win32' && c.env[WIN_KEY] === 'WinBase'),
    'win32 无基座': has((c) => c.platform === 'win32' && !(WIN_KEY in c.env)),
    'darwin': has((c) => c.platform === 'darwin'),
    'linux 有 XDG': has((c) => c.platform === 'linux' && c.env[XDG_KEY] === 'XdgBase'),
    'linux 无 XDG': has((c) => c.platform === 'linux' && !(XDG_KEY in c.env)),
  };
  const coverBad = Object.keys(cover).filter((k) => !cover[k]);
  check('G-4 覆盖矩阵齐全（四平台有/无基座 + 三变量三种纯空白 + 两种未设置基线）', coverBad.length === 0,
    coverBad.length ? '缺: ' + coverBad.join(', ') : Object.keys(cover).length + ' 项齐全');

  // ⑤ 结构对账：两侧实现逐字等于冻结字面量（Rust 未编译时的漂移检测）
  const jsSrc = fs.readFileSync(JS_PATH, 'utf8');
  const jsBody = (/function envBase\(env, name\) \{([\s\S]*?)\n\}/.exec(jsSrc) || [])[1] || '';
  const JS_NORM = jsBody.split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
  const jsStateRoot = (/function stateRoot\(platform, env, home\) \{([\s\S]*?)\n\}/.exec(jsSrc) || [])[1] || '';
  const RS_NORM = 'value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())';
  const JS_NORM_FROZEN = "const raw = env[name]; if (raw === undefined || raw === null) return null; "
    + "const s = String(raw).trim(); return s === '' ? null : s;";
  check('G-5 brand.rs 的 env_base 逐字等于冻结规则（trim 后为空 ⇒ 未设置，非空取 trim 后的值）',
    RS_ENV_BASE_LINE === RS_NORM && RS_VALUE_TRIMMED && RS_BLANK_EMPTY_ONLY && !RS_BLANK_TRIMMED,
    RS_ENV_BASE_LINE === RS_NORM ? 'ok' : 'rs=' + JSON.stringify(RS_ENV_BASE_LINE) + ' ≠ ' + JSON.stringify(RS_NORM));
  check('G-6 brand.js 的 envBase 逐字等于冻结规则（与 brand.rs 同一规则）',
    JS_NORM === JS_NORM_FROZEN, JS_NORM === JS_NORM_FROZEN ? 'ok' : 'js=' + JSON.stringify(JS_NORM));
  check('G-7 两侧两个基座分支都接上同一个归一化入口（win32/Linux 无旁路）',
    RS_WIN_WIRED && RS_LINUX_WIRED
      && /envBase\(env, STATE_ROOT_WIN_BASE_ENV\)/.test(jsStateRoot)
      && /envBase\(env, STATE_ROOT_LINUX_XDG_ENV\)/.test(jsStateRoot),
    'rs win=' + RS_WIN_WIRED + ' linux=' + RS_LINUX_WIRED);
}

// ── H. 旧状态根/旧守卫的**检测**（D-2/P-2：不迁移，但绝不静默，且防双守卫）──────────
// 旧名（LEGACY_PRODUCT_NAME = 'dsh-supervisor'）是**唯一**允许保留的旧名：它只用于检测与告警。
// 本节把两件事钉死：① 旧状态根三平台推导（与 stateRoot 同基座、只换末段，冻结字面量判）；
//   ② 检测的四个输入分支 + 真跑 CLI 的拒绝路径（旧守卫在跑 ⇒ 明确报错并非零退出，且不写新根）。
{
  const LEGACY = 'dsh-supervisor'; // ← 冻结的旧名（与单源 LEGACY_PRODUCT_NAME 对偶）
  check('H-1 LEGACY_PRODUCT_NAME 等于冻结的旧名（全仓唯一保留的旧名）',
    BRAND.LEGACY_PRODUCT_NAME === 'dsh-supervisor', JSON.stringify(BRAND.LEGACY_PRODUCT_NAME));

  const HH = path.join('H', 'home');
  const HCASES = [
    ['win32 有基座', BRAND.legacyStateRoot('win32', { LOCALAPPDATA: 'L' }, HH), path.join('L', LEGACY)],
    ['win32 基座缺失回落家目录', BRAND.legacyStateRoot('win32', {}, HH), path.join(HH, 'AppData', 'Local', LEGACY)],
    ['darwin 恒为 Application Support', BRAND.legacyStateRoot('darwin', {}, HH), path.join(HH, 'Library', 'Application Support', LEGACY)],
    ['linux 有 XDG_STATE_HOME', BRAND.legacyStateRoot('linux', { XDG_STATE_HOME: 'X' }, HH), path.join('X', LEGACY)],
    ['linux 基座缺失回落 ~/.local/state', BRAND.legacyStateRoot('linux', {}, HH), path.join(HH, '.local', 'state', LEGACY)],
  ];
  const hBad = HCASES.filter((c) => c[1] !== c[2]).map((c) => c[0] + ': ' + c[1] + ' ≠ ' + c[2]);
  check('H-2 旧状态根三平台推导逐字正确（5 条，冻结字面量）', hBad.length === 0, hBad.join(' | '));
  check('H-3 同平台上旧根 ≠ 新根（末段必须不同，否则等于把新根当旧根报）',
    ['win32', 'darwin', 'linux'].every((p) => BRAND.legacyStateRoot(p, {}, HH) !== BRAND.stateRoot(p, {}, HH)),
    BRAND.legacyStateRoot('linux', {}, HH) + ' vs ' + BRAND.stateRoot('linux', {}, HH));

  const sr2 = require(path.join(ROOT, 'src', 'platform', 'service', 'state-root.js'));
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'lobox-legacy-probe-'));
  try {
    const absent = sr2.detectLegacyInstall({ rootOverride: path.join(probe, 'not-there'), isAlive: () => true });
    check('H-4 旧根不存在：exists=false、不报旧守卫、也不碰文件系统',
      absent.exists === false && absent.guardRunning === false, JSON.stringify(absent));

    const dirOnly = path.join(probe, 'dir-only');
    fs.mkdirSync(path.join(dirOnly, 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(dirOnly, 'state.json'), '{}');
    const d1 = sr2.detectLegacyInstall({ rootOverride: dirOnly, isAlive: () => true });
    check('H-5 旧根存在但无锁：exists=true、entries 可读、guardRunning=false（只告警不拦）',
      d1.exists === true && d1.guardRunning === false && d1.entries.indexOf('state.json') >= 0
        && d1.lockFile === path.join(dirOnly, 'supervisor', 'guard.lock'),
      JSON.stringify({ exists: d1.exists, entries: d1.entries, running: d1.guardRunning }));

    const lockDir = path.join(probe, 'with-lock');
    fs.mkdirSync(path.join(lockDir, 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'supervisor', 'guard.lock'), JSON.stringify({ pid: 424242, started: 1 }));
    const alive = sr2.detectLegacyInstall({ rootOverride: lockDir, isAlive: () => true });
    check('H-6 旧锁 pid 存活 ⇒ guardRunning=true（拒绝启动的唯一依据）',
      alive.guardRunning === true && alive.lockPid === 424242, JSON.stringify(alive));
    const dead = sr2.detectLegacyInstall({ rootOverride: lockDir, isAlive: () => false });
    check('H-7 旧锁 pid 已死 ⇒ guardRunning=false（陈旧锁不阻挡新版本）',
      dead.guardRunning === false && dead.lockPid === 424242, JSON.stringify(dead));
    fs.writeFileSync(path.join(lockDir, 'supervisor', 'guard.lock'), '424242');
    const bare = sr2.detectLegacyInstall({ rootOverride: lockDir, isAlive: () => true });
    check('H-8 旧锁的裸 pid 历史格式同样被认（否则一次升级就把在用旧锁看成无效）',
      bare.guardRunning === true && bare.lockPid === 424242, JSON.stringify(bare));
    check('H-9 检测只读：旧根内容与锁文件一个字节都没被改动',
      fs.readFileSync(path.join(lockDir, 'supervisor', 'guard.lock'), 'utf8') === '424242'
        && fs.existsSync(path.join(dirOnly, 'state.json')),
      fs.readdirSync(lockDir).join(','));

    // H-10/H-11：真跑 CLI（bin/lobox daemon）—— 旧守卫在跑时必须明确报错、非零退出，且**不在新根留东西**。
    //   旧根按平台默认基座推出（家目录/基座都指到探针目录，绝不碰真机旧状态）；新根用覆盖位隔离。
    const CLI = path.join(ROOT, 'bin', 'lobox');
    const fakeHome = path.join(probe, 'home');
    const cliEnv = Object.assign({}, process.env, { HOME: fakeHome, USERPROFILE: fakeHome });
    delete cliEnv[BRAND.ENV_STATE_ROOT];
    delete cliEnv[BRAND.STATE_ROOT_WIN_BASE_ENV];
    delete cliEnv[BRAND.STATE_ROOT_LINUX_XDG_ENV];
    const legacyRoot = process.platform === 'win32'
      ? path.join(fakeHome, 'AppData', 'Local', LEGACY)
      : process.platform === 'darwin'
        ? path.join(fakeHome, 'Library', 'Application Support', LEGACY)
        : path.join(fakeHome, '.local', 'state', LEGACY);
    fs.mkdirSync(path.join(legacyRoot, 'supervisor'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'supervisor', 'guard.lock'),
      JSON.stringify({ pid: process.pid, started: Date.now(), entry: path.join(legacyRoot, 'bin', 'old-cli') }));
    const newRoot = path.join(probe, 'new-root');
    cliEnv[BRAND.ENV_STATE_ROOT] = newRoot;
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [CLI, 'daemon'], { env: cliEnv, encoding: 'utf8', timeout: 30000 });
    } catch (e) {
      code = (e && typeof e.status === 'number') ? e.status : -1;
      out = String((e && e.stdout) || '') + String((e && e.stderr) || '') + String((e && e.message) || '');
    }
    check('H-10 旧守卫在跑时 daemon 拒绝启动：非零退出 + 明确报错 + 指向「先卸载旧版本」',
      code !== 0 && /旧版/.test(out) && /防双守卫/.test(out) && /卸载/.test(out),
      'code=' + code + ' out=' + out.replace(/\s+/g, ' ').slice(0, 200));
    check('H-11 拒绝发生在写新根之前（新根里没有 config.json / guard.lock）',
      !fs.existsSync(path.join(newRoot, 'supervisor', 'config.json'))
        && !fs.existsSync(path.join(newRoot, 'supervisor', 'guard.lock')),
      fs.existsSync(newRoot) ? fs.readdirSync(newRoot).join(',') : '(新根未创建)');
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

// ── I. macOS LaunchAgent label：必须从 identifier **派生**（反向域名根全仓只允许一处）──────────
// 波 1 的缺陷：label 写成 `com.lobox.*`、identifier 是 `dev.bowen.lobox` —— 同一套反向域名根出现两个根。
// 本节把两件事钉死（A-1 只比「常量名集合」，label 改成求值派生后不再被 A-1 覆盖，故必须在此独立锚定）：
//   ① 两侧都是**求值派生**（JS 函数 ↔ Rust `format!` + TAURI_IDENTIFIER），值逐字等于冻结字面量；
//   ② 结构证据：单源两侧反向域名根字面量各只有一处（= identifier 声明），消费点也没有自己再写一份。
{
  const FROZEN_IDENTIFIER = 'dev.bowen.lobox'; // 冻结的反向域名根（与单源对偶的独立预言值）
  const labels = [
    ['守卫', BRAND.macosGuardLabel(), FROZEN_IDENTIFIER + '.core', 'core'],
    ['壳', BRAND.macosGuiLabel(), FROZEN_IDENTIFIER + '.shell', 'shell'],
  ];
  const bad = [];
  for (const [what, got, want, suffix] of labels) {
    if (typeof got !== 'string') { bad.push(what + ' 不是字符串：' + JSON.stringify(got)); continue; }
    if (got !== want) bad.push(what + '=' + JSON.stringify(got) + ' ≠ 冻结值 ' + JSON.stringify(want));
    if (got !== BRAND.TAURI_IDENTIFIER + '.' + suffix) {
      bad.push(what + ' 不是从 TAURI_IDENTIFIER 派生的：' + JSON.stringify(got) + ' ≠ TAURI_IDENTIFIER+".' + suffix + '"');
    }
  }
  check('I-1 两个 macOS label 逐字等于冻结值、且逐字等于 TAURI_IDENTIFIER + 固定后缀（派生而非复制）',
    bad.length === 0, bad.join(' | '));
  check('I-2 两个 label 互不相同、都是 identifier 的后代（同一套反向域名根）',
    labels[0][1] !== labels[1][1]
    && labels.every(([, got]) => got.indexOf(FROZEN_IDENTIFIER + '.') === 0)
    && BRAND.TAURI_IDENTIFIER === FROZEN_IDENTIFIER,
    labels.map(([w, got]) => w + '=' + got).join(' | '));

  // 结构证据①：单源两侧各自只有一处反向域名根字面量（就是 identifier 声明本身）。
  const jsRoots = (fs.readFileSync(JS_PATH, 'utf8').match(/'dev\.bowen\.[^']*'/g) || []);
  const rsRoots = (rust.src.match(/"dev\.bowen\.[^"]*"/g) || []);
  check('I-3 单源两侧各自只有一处反向域名根字面量（= TAURI_IDENTIFIER；label 没有把根抄第二遍）',
    jsRoots.length === 1 && jsRoots[0] === "'" + FROZEN_IDENTIFIER + "'"
    && rsRoots.length === 1 && rsRoots[0] === '"' + FROZEN_IDENTIFIER + '"',
    'js=' + JSON.stringify(jsRoots) + ' rs=' + JSON.stringify(rsRoots));

  // 结构证据②：brand.rs 的两个 label 函数体必须引用 TAURI_IDENTIFIER，字面量只能是一个后缀。
  const rsFnNorm = (name) => {
    const at = rust.src.indexOf('fn ' + name + '(');
    if (at < 0) return '';
    const rest = rust.src.slice(at);
    const end = rest.indexOf('\n}');
    return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
  };
  const guardFn = rsFnNorm('macos_guard_label');
  const guiFn = rsFnNorm('macos_gui_label');
  check('I-4 brand.rs 两个 label 函数体逐字从 TAURI_IDENTIFIER 派生（format! + 单一后缀字面量）',
    /format!\("\{\}\.core", TAURI_IDENTIFIER\)/.test(guardFn)
    && /format!\("\{\}\.shell", TAURI_IDENTIFIER\)/.test(guiFn),
    'guard=' + JSON.stringify(guardFn.slice(0, 110)) + ' gui=' + JSON.stringify(guiFn.slice(0, 110)));

  // 结构证据③：消费点走派生入口，且自己不再写 label 字面量（含波 1 的 com.lobox.* 旧根）。
  const darwinSrc = fs.readFileSync(path.join(ROOT, 'src', 'platform', 'os', 'autostart', 'darwin.js'), 'utf8');
  const macosSrc = fs.readFileSync(path.join(ROOT, '..', 'shell', 'src-tauri', 'src', 'platform', 'macos.rs'), 'utf8');
  check('I-5 消费点走派生入口：darwin.js 调 brand 的 label 函数、macos.rs 调 brand::macos_guard_label',
    /BRAND\.macosGuardLabel\(\)/.test(darwinSrc) && /BRAND\.macosGuiLabel\(\)/.test(darwinSrc)
    && /crate::brand::macos_guard_label\(\)/.test(macosSrc),
    'darwin-call=' + /BRAND\.macos(Guard|Gui)Label\(\)/.test(darwinSrc)
      + ' macos-rs-call=' + /crate::brand::macos_guard_label\(\)/.test(macosSrc));
  const labelRoots = [];
  for (const [rel, src] of [['darwin.js', darwinSrc], ['macos.rs', macosSrc]]) {
    for (const m of src.matchAll(/(?:com|dev)\.bowen\.[A-Za-z.]*|com\.lobox\.[A-Za-z]*/g)) labelRoots.push(rel + ':' + m[0]);
  }
  check('I-6 消费点里没有任何 label 字面量（com.lobox.* / *.bowen.* 皆为 0 命中）',
    labelRoots.length === 0, labelRoots.join(','));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
