'use strict';

const fs = require('node:fs');
const pidlookup = require('./pidlookup');
const path = require('node:path');
const os = require('node:os');

function candidateNames(base, platform) {
  const win = (platform || process.platform) === 'win32';
  if (!win) return [base];
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = [base + '.exe', base + '.cmd', base + '.bat'];
  for (const e of exts) {
    const n = base + e.toLowerCase();
    if (!names.some((x) => x.toLowerCase() === n)) names.push(n);
  }
  names.push(base);
  return [...new Set(names)];
}

// POSIX 必须校验执行位（0644 不可作候选，否则 spawn EACCES 并污染「已安装」判定）；win32 无执行位语义。
function isExecutableFile(p, platform) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if ((platform || process.platform) === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function firstExecutable(dir, base, platform) {
  if (!dir) return null;
  for (const name of candidateNames(base, platform)) {
    const p = path.join(dir, name);
    try { if (isExecutableFile(p, platform)) return p; } catch {  }
  }
  return null;
}

// 全局工具链落点单源（与 shell/src-tauri/src/env.rs#global_install_root 逐字对应，R7 门禁锁一致性）。
// 决策：产品不做私有化 —— 工具链装到用户级全局目录并登记进 PATH，使终端与其它产品都能看见。
// 机器级目录（Program Files / /usr/local）无管理员时不可写，故只取用户级。
const GLOBAL_APP_DIRNAME = 'lobox';
const GLOBAL_BIN_DIRNAME = 'bin';

function globalInstallRoot(platform, home, env) {
  const pl = platform || process.platform;
  const h = home || os.homedir();
  const e = env || process.env;
  if (pl === 'win32') {
    const appdata = e.APPDATA || path.join(h, 'AppData', 'Roaming');
    return path.join(appdata, GLOBAL_APP_DIRNAME, GLOBAL_BIN_DIRNAME);
  }
  return path.join(h, '.local', GLOBAL_BIN_DIRNAME);
}

function standardDirs(platform, home, env) {
  const pl = platform || process.platform;
  const h = home || os.homedir();
  const e = env || process.env;
  const dirs = [];
  if (pl === 'win32') {
    if (e.APPDATA) dirs.push(path.join(e.APPDATA, 'npm'));
    if (e.LOCALAPPDATA) dirs.push(path.join(e.LOCALAPPDATA, 'Programs', 'lobox'));
    dirs.push(path.join(h, '.local', 'bin'));
  } else {
    dirs.push(path.join(h, '.local', 'bin'));
    dirs.push(path.join(h, '.npm-global', 'bin'));
    if (pl === 'darwin') { dirs.push('/opt/homebrew/bin'); dirs.push('/usr/local/bin'); }
  }
  return dirs;
}

function inPath(base, platform, env) {
  const e = env || process.env;
  const raw = e.PATH || e.Path || '';
  for (const d of raw.split(path.delimiter)) {
    if (!d) continue;
    const hit = firstExecutable(d, base, platform);
    if (hit) return hit;
  }
  return null;
}

function resolveExecutable(base, opts) {
  const o = opts || {};
  const pl = o.platform;
  const env = o.env;
  const E = env || process.env;
  if (o.envVar && E[o.envVar]) {
    const v = E[o.envVar];
    if (isExecutableFile(v, pl)) return v;
  }
  // platform/env 必须向下传播，否则 npmBin({platform:win32}) 在 Linux 上按宿主规则解析出 POSIX 路径。
  const inPathHit = inPath(base, pl, env);
  if (inPathHit) return inPathHit;
  for (const d of [...(o.extraDirs || []), ...standardDirs(pl, undefined, env)]) {
    const hit = firstExecutable(d, base, pl);
    if (hit) return hit;
  }
  return null;
}

function npxBin(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  if (pl !== 'win32') return 'npx';
  const resolved = resolveExecutable('npx', { platform: pl, env, extraDirs: [
    env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
  ].filter(Boolean) });
  if (resolved) return resolved;
  return 'npx.cmd';
}

function npmBin(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  if (pl !== 'win32') return 'npm';
  const resolved = resolveExecutable('npm', { platform: pl, env, extraDirs: [
    env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
  ].filter(Boolean) });
  if (resolved) return resolved;
  return 'npm.cmd';
}

const DSH_PKG = ['@deepseek-ai', 'dsh'];

function dshJsIn(prefix) {
  return path.join(prefix, 'node_modules', ...DSH_PKG, 'lib', 'bin.js');
}





// 复杂环境兜底：DSH 入口判定单一事实源（R8）仍是本函数。本机实测暴露三类真实"已装且能跑"形态，
// 既有探测（DSH_BIN / PATH 裸名 / npmRoot / 全局 prefix）全部漏掉就会把正确安装判成"未安装"而弹安装页：
//   (1) 一层 shim（如 Roaming\\lobox\\bin\\dsh.cmd）不是真 JS 包——它指向某 .dsh-app/lib/bin.js；必须解析 shim 真身，
//       否则 binPath 落到 shim、installedVersion 沿 shim 向上找不到 package.json（本机正是此情形）。
//   (2) harness-home：被监管 DSH 以"产品化安装"落点于 ~/.dsh-app（package.json 即 @deepseek-ai/dsh），既非 npm 全局也非 PATH 裸名。
//   (3) 真机正在运行的 dsh-main 进程：其 cmdline 指向的 .js 入口即"正在服役的 DSH"，不读活进程会漏掉已跑着的安装。
// 三者只在既有探测落空时兜底，对已被识别的安装零回归。
function shimJsTarget(hit) {
  if (!/\.(cmd|bat)$/i.test(hit)) return null;
  let txt = null;
  try { txt = fs.readFileSync(hit, 'utf8'); } catch { return null; }
  const re = /"([^"]+\.(?:js|cjs|mjs))"|(\S+\.(?:js|cjs|mjs))(?=\s|$)/gi;
  let m;
  while ((m = re.exec(txt))) {
    const cand = m[1] || m[2];
    try { const rp = fs.realpathSync(cand); if (fs.statSync(rp).isFile()) return rp; } catch {}
  }
  return null;
}

function harnessHome(env) {
  const e = env || process.env;
  const h = e.HOME || e.USERPROFILE || os.homedir();
  return path.join(h, '.dsh-app');
}

function dshJsFromLive(pl, env) {
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  let port = null;
  try {
    const cfg = (env && env.DSH_CONFIG && typeof env.DSH_CONFIG === 'object') ? env.DSH_CONFIG : null;
    if (cfg && Number.isInteger(cfg.targetPort) && cfg.targetPort > 0) port = cfg.targetPort;
    else if (cfg && cfg.healthUrl) { const u = new URL(cfg.healthUrl); if (u.port) port = Number(u.port); }
  } catch {}
  if (!port) return null;
  let pid = null;
  try { pid = pidlookup.findListeningPid(port); } catch { return null; }
  if (!pid) return null;
  let cmd = null;
  try { cmd = pidlookup.readCmdline(pid); } catch { return null; }
  if (!cmd) return null;
  for (const part of cmd.split(/\s+/).filter(Boolean)) {
    try {
      const rp = fs.realpathSync(part);
      if (isFile(rp) && /\.(js|cjs|mjs)$/i.test(rp)) {
        const js = dshJsIn(path.dirname(rp));
        if (isFile(js)) return asJs(js, rp);
        if (isFile(rp)) return asJs(rp, rp);
      }
    } catch {}
  }
  return null;
}

function resolveDsh(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const asJs = (bin, launcher) => ({ runtime: process.execPath, bin, isJs: true, launcher: launcher || null });
  if (env.DSH_BIN) { try { const r = fs.realpathSync(env.DSH_BIN); if (isFile(r)) return asJs(r, env.DSH_BIN); } catch {} }
  const hit = resolveExecutable('dsh', { platform: pl, env });
  if (hit) {
    const shim = shimJsTarget(hit);
    if (shim) return asJs(shim, hit);
    try { const real = fs.realpathSync(hit); if (isFile(real) && /\.(js|cjs|mjs)$/i.test(real)) return asJs(real, hit); } catch {}
    const js = dshJsIn(path.dirname(hit));
    if (isFile(js)) return asJs(js, hit);
    if (isFile(hit) && !/\.(cmd|bat|exe)$/i.test(hit)) return asJs(hit, hit);
    return { runtime: null, bin: hit, isJs: false, launcher: hit };
  }
  if (o.npmRoot) { const js = dshJsIn(o.npmRoot); if (isFile(js)) return asJs(js, null); }
  const gRoot = globalInstallRoot(pl, undefined, env);
  { const js = dshJsIn(gRoot); if (isFile(js)) return asJs(js, null); }
  { const js = dshJsIn(harnessHome(env)); if (isFile(js)) return asJs(js, null); }
  const live = dshJsFromLive(pl, env);
  if (live) return live;
  return null;
}
function knownDshEntries(opts) {
  const o = opts || {};
  const out = [];
  try {
    const r = resolveDsh(o);
    if (r) {
      if (typeof r.bin === 'string' && r.bin) out.push(r.bin);
      if (typeof r.launcher === 'string' && r.launcher) out.push(r.launcher);
    }
  } catch {  }
  if (o.npmRoot) { try { out.push(dshJsIn(o.npmRoot)); } catch {  } }
  if (typeof o.dshBin === 'string' && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(o.dshBin)) out.push(o.dshBin);
  return [...new Set(out.filter((x) => typeof x === 'string' && x))];
}

function commandEntryViolation(cmdArr, opts) {
  const o = opts || {};
  const rp = o.realpath || ((p) => fs.realpathSync(p));
  if (!Array.isArray(cmdArr) || !cmdArr.length) return null;
  const head = String(cmdArr[0] || '');
  const NODE_HEAD = new Set(['node', 'node.exe']);
  const baseOf = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
  let entry = head;
  const nodeHead = NODE_HEAD.has(baseOf(head));
  if (nodeHead) {
    if (cmdArr.length < 2) return '启动命令以 node 打头但缺少 DSH 入口参数';
    entry = String(cmdArr[1] || '');
  }
  if (!entry) return '启动命令缺少 DSH 入口';
  const isAbsolute = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p));
  const hasSep = (p) => /[\\/]/.test(String(p));
  if (!hasSep(entry)) {
    if (nodeHead && o.requireAbsoluteEntry) {
      return 'command[0] 为 node 时 command[1] 必须是绝对路径的 DSH 入口（相对/裸名会按工作目录或 PATH 解析）';
    }
    return null;
  }
  if (!isAbsolute(entry)) {
    return 'DSH 入口不接受相对路径（会按调用方工作目录解析；沙箱实例的该目录沙箱内可写）';
  }
  let real = null;
  try { real = rp(entry); } catch {  }
  if (typeof o.allowEntry === 'function') {
    try { if (o.allowEntry(entry, real)) return null; } catch {  }
  }
  if (real === null) return 'DSH 入口不存在或不可解析（fail-closed）：' + entry;
  for (const f of (Array.isArray(o.files) ? o.files : [])) {
    try { if (rp(f) === real) return null; } catch {  }
  }
  for (const r of (Array.isArray(o.roots) ? o.roots : [])) {
    let rr; try { rr = rp(r); } catch { continue; }
    const base = String(rr).replace(/[\\/]+$/, '');
    if (real === base || real.indexOf(base + path.sep) === 0) return null;
  }
  return 'DSH 入口不在允许位置（须为该实例安装根之下的入口，或内核解析出的已知 DSH 入口）：' + entry;
}

module.exports = {
  resolveExecutable, candidateNames, standardDirs, npmBin, npxBin,
  resolveDsh, dshJsIn, knownDshEntries, commandEntryViolation, isExecutableFile,
  globalInstallRoot, GLOBAL_APP_DIRNAME, GLOBAL_BIN_DIRNAME,
};
