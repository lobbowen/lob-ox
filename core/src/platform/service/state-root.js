'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BRAND = require('../../shared/brand');
const lease = require('../util/lease');

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

function legacyStateRoot() {
  return BRAND.legacyStateRoot(process.platform, process.env, os.homedir());
}

function legacySupervisorDir() {
  return path.join(os.homedir(), BRAND.LEGACY_HARNESS_DIR, BRAND.STATE_SUPERVISOR_SUBDIR);
}
function legacyShellDir() {
  return path.join(os.homedir(), BRAND.LEGACY_HARNESS_DIR, BRAND.STATE_SHELL_SUBDIR);
}

function legacyProductRoot(opts) {
  const o = opts || {};
  const override = o.rootOverride === undefined || o.rootOverride === null ? null : String(o.rootOverride).trim();
  if (override) return path.resolve(override);
  return BRAND.legacyStateRoot(o.platform || process.platform, o.env || process.env, o.home || os.homedir());
}

// pid 存活判据的单一实现是 pidlookup.probeAlive（三态：alive / dead / unknown，
// 正确区分 EPERM=活着 与 ESRCH=已死）。此前此处另有一份只判 EPERM 的简化版，
// 不认 ESRCH 也无整数守卫——同一判据两套结论，unknown 会漏成 dead。
function pidAlive(pid) {
  return require('../os/pidlookup').probeAlive(pid) === 'alive';
}

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
  
  
  
  const pid = lease.lockPid(info.lockFile);
  info.lockPid = pid;
  
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
