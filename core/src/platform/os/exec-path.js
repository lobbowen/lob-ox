'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DSH_PRODUCT } = require('../../domains/agent/model');

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

// ⚠️ 与 shared-constants 的 `state.dirName` **当前同值（"lobox"）但语义不同，不接单源**：
//   `state.dirName` 描述的是「产品的**状态根**叫什么」（`%LOCALAPPDATA%\lobox\`，用户数据目录）；
//   本常量描述的是「npm 全局包装把可执行放到哪」（`%APPDATA%\lobox\bin\`，可执行目录）。
//   两棵不同的目录树、两个产品决策——一个改而不动另一个是正常的，不要因为「值一样」就统一。
//   （2026-10-18 用户裁「两个事实」；此前此处接 SHARED.state.dirName 并注「R21 必须与壳侧
//    逐字相同」，那个注释把两件事说成了一件事。）
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
    if (e.LOCALAPPDATA) dirs.push(path.join(e.LOCALAPPDATA, 'Programs', GLOBAL_APP_DIRNAME));
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

function dshJsIn(prefix) {
  return path.join(prefix, 'node_modules', ...DSH_PRODUCT.pkgSegments, ...DSH_PRODUCT.entryRel);
}

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
  
  
  
  const pidlookup = require('./pidlookup');
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
    // 裸名入口：调用方给出合法裸名白名单时逐字精确校验，未给出则维持既有放行语义。
    //
    // 为什么平台层不自己知道有哪些合法裸名：那是**产品知识**（哪个可执行是合法的 DSH
    // 命令头），平台层只提供校验机制。两者之间原本没有通道——API 层有 DSH_HEAD 白名单、
    // 平台层有这段裸名分支，却从没接上，导致裸名一律放行。本选项就是那条通道。
    //
    // 判据必须是**精确匹配**（===）而非包含：`dsh` / `dsh.cmd` / `dsh.ps1` 合法，
    // 而 `dsh-evil.exe` 不合法但它包含 `dsh`。白名单精确、黑名单才宽
    // （同 §7.18：owns() 的前缀匹配与 proc.matchGuard 的 *lobox*|*dsh* 是宽松判据族，
    //  那是「宁可多匹配再过滤」的场景；这里是「只放行点名的那几个」）。
    const allow = o.allowBareNames;
    if (Array.isArray(allow) && allow.length) {
      const bare = baseOf(entry);
      if (!allow.some((n) => String(n).toLowerCase() === bare)) {
        return '启动命令的裸名不在合法命令头白名单内（放名：' + allow.join(' / ') + '）：' + entry;
      }
      return null;
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
