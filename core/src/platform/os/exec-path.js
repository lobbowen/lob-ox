'use strict';

// 跨平台可执行文件解析：逻辑名 -> 可实际 spawn 的绝对路径或 null，绝不返回不可执行的猜测路径。
// Windows 可执行必须带扩展名（.exe/.cmd/.bat，按 PATHEXT 展开），全局 bin 是 %APPDATA%\npm；
// Unix 标准目录 ~/.local/bin、~/.npm-global/bin，macOS 追加 /opt/homebrew/bin、/usr/local/bin；顺序：env 覆盖 -> PATH -> 标准目录。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 候选文件名（含平台扩展名；platform 可注入以便纯函数测试）。 */
function candidateNames(base, platform) {
  const win = (platform || process.platform) === 'win32';
  if (!win) return [base];
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const names = [base + '.exe', base + '.cmd', base + '.bat'];
  for (const e of exts) {
    const n = base + e.toLowerCase();
    if (!names.some((x) => x.toLowerCase() === n)) names.push(n);
  }
  names.push(base); // 无扩展名兜底（少数 shim 形态）
  return [...new Set(names)];
}

/** 必须校验执行位：POSIX 上 0644 普通文件（半截安装、误拷贝）不可作候选返回，否则 spawn 以 EACCES
 *  失败且污染上层「已安装」判定；win32 无执行位语义，维持 isFile。
 *  platform 可注入：宿主与注入平台不一致时按注入侧走，保证纯函数测试可穷举。 */
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
    try { if (isExecutableFile(p, platform)) return p; } catch { /* 不存在/无权：跳过 */ }
  }
  return null;
}

/** 标准安装目录（按优先级；跨平台）。platform/env 可注入：宿主与注入平台不一致时按注入侧解析，
 *  纯函数测试可穷举。 */
function standardDirs(platform, home, env) {
  const pl = platform || process.platform;
  const h = home || os.homedir();
  const e = env || process.env;
  const dirs = [];
  if (pl === 'win32') {
    if (e.APPDATA) dirs.push(path.join(e.APPDATA, 'npm'));
    if (e.LOCALAPPDATA) dirs.push(path.join(e.LOCALAPPDATA, 'Programs', 'dsh-supervisor'));
    dirs.push(path.join(h, '.local', 'bin')); // 兼容旧布局（未必存在，解析时按可执行文件过滤）
  } else {
    dirs.push(path.join(h, '.local', 'bin'));
    dirs.push(path.join(h, '.npm-global', 'bin'));
    if (pl === 'darwin') { dirs.push('/opt/homebrew/bin'); dirs.push('/usr/local/bin'); }
  }
  return dirs;
}

/** PATH 内查找（跨平台；Windows 走 PATHEXT；兼容大小写不一的 Path）。env 可注入，理由同 standardDirs。 */
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

/**
 * 解析可执行绝对路径。
 * @returns {string|null} 绝对路径或 null
 */
function resolveExecutable(base, opts) {
  const o = opts || {};
  const pl = o.platform;              // 未传 = 宿主平台
  const env = o.env;                  // 未传 = process.env
  const E = env || process.env;
  if (o.envVar && E[o.envVar]) {
    const v = E[o.envVar];
    // 显式覆盖同样必须是可执行文件（不可执行时继续常规解析，而非把 EACCES 留给 spawn）。
    if (isExecutableFile(v, pl)) return v;
  }
  // platform / env 必须向下传播：否则 npmBin({platform:win32}) 在 Linux 上按宿主规则解析出 POSIX 路径。
  const inPathHit = inPath(base, pl, env);
  if (inPathHit) return inPathHit;
  for (const d of [...(o.extraDirs || []), ...standardDirs(pl, undefined, env)]) {
    const hit = firstExecutable(d, base, pl);
    if (hit) return hit;
  }
  return null;
}

/** 解析 npx 的可执行路径（跨平台）。Windows 实际可执行是 npx.cmd：Node 的 spawn/execFile 不做
 *  PATHEXT 解析，裸 npx 一律 ENOENT；解析失败仍返回 npx.cmd（失败留给调用方，不把 null 传进 spawn）。platform 可注入便于纯函数测试。 */
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

/** 解析 npm 的可执行路径（跨平台），全仓唯一解析入口。Windows 实际可执行是 npm.cmd：spawn/execFileSync
 *  不做 PATHEXT 解析，裸 npm 一律 ENOENT，故 Windows 走 PATHEXT（优先 .cmd）、其余平台直接用 npm；解析失败返回可执行名而非 null，沿用调用方既有错误路径。platform 可注入。 */
function npmBin(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  if (pl !== 'win32') return 'npm';
  const resolved = resolveExecutable('npm', { platform: pl, env, extraDirs: [
    env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
  ].filter(Boolean) });
  if (resolved) return resolved;
  // 解析不到时仍返回 npm.cmd：Windows 上裸 npm 可执行概率近零，npm.cmd 至少 PATH 生效时能被
  // cmd.exe 找到（把失败留给调用方的错误处理）。
  return 'npm.cmd';
}

const DSH_PKG = ['@deepseek-ai', 'dsh'];

function dshJsIn(prefix) {
  return path.join(prefix, 'node_modules', ...DSH_PKG, 'lib', 'bin.js');
}

/** 解析原生 DSH 的可执行入口（跨平台，优先包内 JS）。不得按裸逻辑名 'dsh' 判已安装：node 不做 PATH
 *  解析、Windows 裸 dsh 无扩展名。顺序：DSH_BIN -> PATH（Windows 走 PATHEXT）-> 标准落点 ->
 *  <npmRoot>/node_modules/@deepseek-ai/dsh/lib/bin.js。返回 { runtime, bin, isJs, launcher }：命中包内 JS 用当前 node 执行，
 *  只命中垫片则反查同前缀包内 JS；都没有返回 null（调用方如实报「未安装」，绝不猜）。 */
function resolveDsh(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const asJs = (bin, launcher) => ({ runtime: process.execPath, bin, isJs: true, launcher: launcher || null });
  // (1) 显式覆盖
  if (env.DSH_BIN) { try { const r = fs.realpathSync(env.DSH_BIN); if (isFile(r)) return asJs(r, env.DSH_BIN); } catch {} }
  // (2) PATH -> 标准落点
  const hit = resolveExecutable('dsh', { platform: pl, env });
  if (hit) {
    // Unix：dsh 常是软链 -> canonicalize 到包内 lib/bin.js
    try { const real = fs.realpathSync(hit); if (isFile(real) && /\.(js|cjs|mjs)$/i.test(real)) return asJs(real, hit); } catch {}
    // Windows：.cmd 垫片 -> 同前缀的包内 JS
    const js = dshJsIn(path.dirname(hit));
    if (isFile(js)) return asJs(js, hit);
    // 无扩展名 JS（Unix 包内入口）-> 交给 node
    if (isFile(hit) && !/\.(cmd|bat|exe)$/i.test(hit)) return asJs(hit, hit);
    // 只能是垫片：调用方需 shell 承载（Windows）
    return { runtime: null, bin: hit, isJs: false, launcher: hit };
  }
  // (3) npm 全局 root 反查（调用方注入；不在此处执行 npm —— 保持纯解析）
  if (o.npmRoot) { const js = dshJsIn(o.npmRoot); if (isFile(js)) return asJs(js, null); }
  return null;
}

/** 内核已知的 DSH 入口位置（单一事实源：复用 resolveDsh()/dshJsIn()，供 api 形态闸与启动期复校共用）。
 *  返回可能不存在的候选绝对路径，调用方按需 realpath（不存在者自动跳过）。
 *  调用方不得自行硬编码包路径子串判「官方包内入口」——第二份事实源可被伪包内路径（/tmp/... 前缀）绕过。
 *  @param {{platform?:string, env?:object, npmRoot?:string, dshBin?:string}} [opts] @returns {string[]} */
function knownDshEntries(opts) {
  const o = opts || {};
  const out = [];
  try {
    const r = resolveDsh(o);
    if (r) {
      if (typeof r.bin === 'string' && r.bin) out.push(r.bin);           // 已 realpath 的入口
      if (typeof r.launcher === 'string' && r.launcher) out.push(r.launcher); // 垫片/软链原路径
    }
  } catch { /* 解析失败：无已知入口（调用方按 fail-closed 自行决定） */ }
  if (o.npmRoot) { try { out.push(dshJsIn(o.npmRoot)); } catch { /* 前缀非法：跳过 */ } }
  // 配置的 DSH 可执行名：仅当它是绝对路径时才作为候选（裸名由 PATH 解析覆盖）。
  if (typeof o.dshBin === 'string' && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(o.dshBin)) out.push(o.dshBin);
  return [...new Set(out.filter((x) => typeof x === 'string' && x))];
}

/** 启动命令「入口归属」校验（纯函数：api 形态闸与启动期复校共用，避免第二份）。inst.command 是用户可填自由 argv、
 *  原样交给 systemd-run，basename 白名单可被「把脚本命名为 dsh*.js」绕过，故保守即拒绝（误放行=执行任意代码）。
 *  判据：[node,<entry>,...] 取 entry=cmdArr[1] 否则 cmdArr[0]；裸名放行交 PATH 解析（内核默认命令正是此形态，不得误拒），requireAbsoluteEntry（api 闸）下 node 打头的裸名亦拒；
 *  相对路径拒（按沙箱内可写的 workingDir 解析）；绝对路径须 allowEntry 放行或 realpath（root/file 两侧均 realpath，防安装根内软链指向 /tmp）后精确等于 files 之一/位于 roots 下，realpath 失败即拒（fail-closed，防「先提交、后由外部创建」绕过）。@returns {string|null} 违规原因；null=通过 */
function commandEntryViolation(cmdArr, opts) {
  const o = opts || {};
  const rp = o.realpath || ((p) => fs.realpathSync(p));
  if (!Array.isArray(cmdArr) || !cmdArr.length) return null; // 无判定对象（默认命令由域内生成）
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
  // 裸名：交 PATH 解析（内核默认命令 native/main 即 [node, 裸 dshBin]）。
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
  try { real = rp(entry); } catch { /* 不存在/不可解析：下面按 fail-closed 判 */ }
  if (typeof o.allowEntry === 'function') {
    try { if (o.allowEntry(entry, real)) return null; } catch { /* 策略异常：按未放行继续 */ }
  }
  if (real === null) return 'DSH 入口不存在或不可解析（fail-closed）：' + entry;
  for (const f of (Array.isArray(o.files) ? o.files : [])) {
    try { if (rp(f) === real) return null; } catch { /* 候选不存在：跳过 */ }
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
};
