'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BRAND = require('../../shared/brand');

const SCHEMA = 1;

function root() {
  const override = process.env[BRAND.ENV_STATE_ROOT];
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return BRAND.stateRoot(process.platform, process.env, os.homedir());
}

function supervisorDir() {
  return path.join(root(), BRAND.STATE_SUPERVISOR_SUBDIR);
}

function shellDir() {
  return path.join(root(), BRAND.STATE_SHELL_SUBDIR);
}

// 旧产品状态根（未加 override 的平台默认根）：只用于检测，见 detectLegacyInstall。
function legacyStateRoot() {
  return BRAND.legacyStateRoot(process.platform, process.env, os.homedir());
}

function legacySupervisorDir() {
  return path.join(os.homedir(), BRAND.LEGACY_HARNESS_DIR, BRAND.STATE_SUPERVISOR_SUBDIR);
}
function legacyShellDir() {
  return path.join(os.homedir(), BRAND.LEGACY_HARNESS_DIR, BRAND.STATE_SHELL_SUBDIR);
}

// ── 旧状态根 / 旧守卫的**检测**（D-2/P-2：不迁移，但绝不静默，且防双守卫）──────────────
// 旧状态根 = 改名前的产品名那一份（三平台同规则、只换末段，见 brand.legacyStateRoot）。
// 为什么必须有这段：旧状态根不在 migrateLegacy() 的迁移源里，改名后新代码看不见它 ——
//   ① 只有一条明确日志/事件，用户才知道「配置与远程令牌去哪了」；
//   ② 旧守卫若仍在跑，两代守卫会双写状态/竞态 spawn ⇒ 必须**显式拒绝启动**并给出卸载指引。

/** 旧状态根（可注入 rootOverride/platform/env/home/isAlive 以便断言）。 */
function legacyProductRoot(opts) {
  const o = opts || {};
  const override = o.rootOverride === undefined || o.rootOverride === null ? null : String(o.rootOverride).trim();
  if (override) return path.resolve(override);
  return BRAND.legacyStateRoot(o.platform || process.platform, o.env || process.env, o.home || os.homedir());
}

/** pid 是否存活（与 bin/lobox 的让位判定同口径：EPERM 视为存活）。 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * 检测旧安装：旧状态根是否存在 + 旧守卫是否仍在运行（旧锁文件 + 存活 pid）。
 * 返回 { root, supervisorDir, shellDir, exists, entries, lockFile, lockPid, guardRunning }。
 * 只读、不写、不搬 —— 调用方（bin/lobox daemon）据此决定「告警」还是「拒绝启动」。
 */
function detectLegacyInstall(opts) {
  const o = opts || {};
  const isAlive = typeof o.isAlive === 'function' ? o.isAlive : pidAlive;
  const rootDir = legacyProductRoot(o);
  const supDir = path.join(rootDir, BRAND.STATE_SUPERVISOR_SUBDIR);
  const info = {
    root: rootDir,
    supervisorDir: supDir,
    shellDir: path.join(rootDir, BRAND.STATE_SHELL_SUBDIR),
    exists: false,
    entries: [],
    lockFile: path.join(supDir, 'guard.lock'),
    lockPid: null,
    guardRunning: false,
  };
  try { info.exists = fs.statSync(rootDir).isDirectory(); } catch { info.exists = false; }
  if (info.exists) {
    try { info.entries = fs.readdirSync(rootDir); } catch { info.entries = []; }
  }
  // 锁内容兼容两种历史格式（JSON {pid,...} 与裸 pid 数字），与 bin/lobox 的 readLock 同口径。
  //   ⚠ `JSON.parse('424242')` 是**合法** JSON（得到数字）：只认对象会漏掉裸 pid 形态，
  //   于是一次升级就把在用的旧锁看成无效锁 ⇒ 双守卫。
  let pid = null;
  try {
    const raw = fs.readFileSync(info.lockFile, 'utf8');
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') pid = j.pid;
      else if (Number.isInteger(j)) pid = j;
    } catch { /* 非 JSON：落到下面的裸 pid 解析 */ }
    if (!Number.isInteger(pid) || pid <= 0) {
      const n = parseInt(raw, 10);
      pid = Number.isInteger(n) && n > 0 ? n : null;
    }
  } catch { pid = null; }
  info.lockPid = pid;
  // 排除「本进程自己」：否则自身 pid 恰好被写进旧锁时会自我拒绝。
  if (pid !== null && pid !== process.pid && isAlive(pid)) info.guardRunning = true;
  return info;
}

function why(e) { return ((e && e.code) ? e.code + ': ' : '') + ((e && e.message) || String(e)); }

function migrateLegacy() {
  const moved = [];
  const skipped = [];
  const failed = [];
  for (const [from, to] of [
    [legacySupervisorDir(), supervisorDir()],
    [legacyShellDir(), shellDir()],
  ]) {
    if (!fs.existsSync(from)) continue;
    try { fs.mkdirSync(to, { recursive: true }); } catch (e) { failed.push({ from, entry: null, error: why(e) }); continue; }
    let names = [];
    try { names = fs.readdirSync(from); } catch (e) { failed.push({ from, entry: null, error: why(e) }); continue; }
    for (const name of names) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      if (fs.existsSync(dst)) { skipped.push(src); continue; }
      try { fs.renameSync(src, dst); moved.push(src + ' -> ' + dst); } catch (e) { failed.push({ from, entry: name, error: why(e) }); }
    }
    try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from); } catch {  }
  }
  return { moved, skipped, failed };
}

module.exports = { SCHEMA, root, supervisorDir, shellDir, migrateLegacy, legacyStateRoot, legacyProductRoot, detectLegacyInstall, pidAlive };
