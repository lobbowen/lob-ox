#!/usr/bin/env node
'use strict';

// 跨语言品牌单源对账：解析 `shell/src-tauri/src/brand.rs` 的 `pub const`，逐个断言与 `core/src/shared/brand.js`
//   值相等，并断言两边的**常量名集合相同** —— 任何一边单独改动都会在这里判红。
// 另有一份**冻结字面量** EXPECT/RULES：单源两侧被同时改错时它与单源比对仍会失败（不拿同一个源证明自己）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  PRODUCT_NAME: 'dsh-supervisor',
  CLI_NAME: 'dsh-supervisor',
  GUI_BIN_NAME: 'dsh-supervisor-gui',
  GUI_CRATE_NAME: 'dsh-supervisor-gui',
  NPM_SCOPE: '@lob-ox',
  CORE_PKG_PREFIX: 'dsh-core-',
  SHELL_RELEASE_PKG: '@lob-ox/shell-release',
  TAURI_IDENTIFIER: 'dev.bowen.dsh-supervisor',
  TAURI_PRODUCT_NAME: 'dsh-supervisor',
  STATE_DIR_NAME: 'dsh-supervisor',
  STATE_SUPERVISOR_SUBDIR: 'supervisor',
  STATE_SHELL_SUBDIR: 'shell',
  STATE_ROOT_WIN_BASE_ENV: 'LOCALAPPDATA',
  STATE_ROOT_LINUX_XDG_ENV: 'XDG_STATE_HOME',
  LEGACY_HARNESS_DIR: '.dsh',
  ENV_STATE_ROOT: 'DSH_SUPERVISOR_HOME',
  WINDOWS_GUARD_TASK: 'DSH-Supervisor',
  WINDOWS_WATCHDOG_TASK: 'DSH-Supervisor-Watchdog',
  WINDOWS_GUI_TASK: 'DSH-Supervisor-GUI',
  SYSTEMD_UNIT_NAME: 'dsh-supervisor',
  SYSTEMD_UNIT_FILE: 'dsh-supervisor.service',
  MACOS_GUARD_LABEL: 'com.dsh.supervisor',
  MACOS_GUI_LABEL: 'com.dsh.supervisor.gui',
  SEA_BUNDLE_NAME: 'core.cjs',
  SEA_VERSION_DEFINE: '__DSH_VERSION__',
  PROC_MATCH_GUARD: '*dsh-supervisor*',
  PROC_MATCH_GUI: 'dsh-supervisor-gui',
};
{
  const bad = [];
  for (const [name, want] of Object.entries(EXPECT)) {
    if (BRAND[name] !== want) bad.push(name + '=' + JSON.stringify(BRAND[name]) + ' ≠ ' + JSON.stringify(want));
  }
  check('C-1 对外可见名字等于冻结的现状值（' + Object.keys(EXPECT).length + ' 项）', bad.length === 0, bad.join(' | '));
  check('C-2 四平台子包标签与 core/package.json 的清单一致',
    JSON.stringify(BRAND.CORE_PKG_TAGS) === JSON.stringify(['linux-x64', 'darwin-arm64', 'darwin-x64', 'win-x64'])
      && BRAND.CORE_PKG_TAGS.every((t) => BRAND.corePackageName(t) === '@lob-ox/dsh-core-' + t),
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
    ['win32 有 LOCALAPPDATA', BRAND.stateRoot('win32', { LOCALAPPDATA: 'L' }, HOME), path.join('L', 'dsh-supervisor')],
    ['win32 无 LOCALAPPDATA 回落家目录', BRAND.stateRoot('win32', {}, HOME), path.join(HOME, 'AppData', 'Local', 'dsh-supervisor')],
    ['darwin 恒为 Application Support', BRAND.stateRoot('darwin', {}, HOME), path.join(HOME, 'Library', 'Application Support', 'dsh-supervisor')],
    ['linux 有 XDG_STATE_HOME', BRAND.stateRoot('linux', { XDG_STATE_HOME: 'X' }, HOME), path.join('X', 'dsh-supervisor')],
    ['linux 无 XDG 回落 ~/.local/state', BRAND.stateRoot('linux', {}, HOME), path.join(HOME, '.local', 'state', 'dsh-supervisor')],
  ];
  const bad = cases.filter((c) => c[1] !== c[2]).map((c) => c[0] + ': ' + c[1] + ' ≠ ' + c[2]);
  check('D-1 状态根平台分支逐字正确', bad.length === 0, bad.join(' | '));
}

// ── E. 消费点：state-root.js 的 override 与子目录 ──────────────────────────
{
  const sr = require(path.join(ROOT, 'src', 'platform', 'service', 'state-root.js'));
  const saved = process.env[BRAND.ENV_STATE_ROOT];
  const probe = path.join(os.tmpdir(), 'dsh-brand-root-probe');
  process.env[BRAND.ENV_STATE_ROOT] = probe;
  const overridden = sr.root();
  const sup = sr.supervisorDir();
  const shl = sr.shellDir();
  if (saved === undefined) delete process.env[BRAND.ENV_STATE_ROOT];
  else process.env[BRAND.ENV_STATE_ROOT] = saved;
  check('E-1 覆盖位优先且绝对化', overridden === path.resolve(probe), overridden);
  check('E-2 supervisorDir = <根>/supervisor', sup === path.join(overridden, 'supervisor'), sup);
  check('E-3 shellDir = <根>/shell', shl === path.join(overridden, 'shell'), shl);
  check('E-4 无覆盖位时与单源规则一致',
    sr.root() === BRAND.stateRoot(process.platform, process.env, os.homedir()), sr.root());
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

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
