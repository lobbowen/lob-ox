'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ex = require('../util/exec');

const IS_WINDOWS = process.platform === 'win32';
let _icacls = null;

function hasIcacls(platform) {
  if ((platform || process.platform) !== 'win32') return false;
  if (_icacls !== null) return _icacls;
  _icacls = ex.runOut('icacls', ['/?'], { timeoutMs: 3000 }) !== null;
  return _icacls;
}

function currentUser() {
  return process.env.USERNAME || process.env.USER || (() => { try { return os.userInfo().username; } catch { return null; } })();
}

function protectFile(file) {
  if (!IS_WINDOWS) {
    try { fs.chmodSync(file, 0o600); return { ok: true, mode: 'posix-0600' }; }
    catch (e) { return { ok: false, mode: 'posix-0600', reason: e.message }; }
  }
  if (!hasIcacls()) return { ok: false, mode: 'none', reason: 'icacls 不可用' };
  const user = currentUser();
  if (!user) return { ok: false, mode: 'icacls', reason: '无法确定当前用户' };
  const r = ex.runDetail('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore', timeoutMs: 5000 });
  return r.ok
    ? { ok: true, mode: 'icacls-file' }
    : { ok: false, mode: 'icacls-file', reason: r.error || ('退出码 ' + r.code) };
}

function protectDir(dir) {
  if (!IS_WINDOWS) {
    try { fs.chmodSync(dir, 0o700); return { ok: true, mode: 'posix-0700' }; }
    catch (e) { return { ok: false, mode: 'posix-0700', reason: e.message }; }
  }
  if (!hasIcacls()) return { ok: false, mode: 'none', reason: 'icacls 不可用' };
  const user = currentUser();
  if (!user) return { ok: false, mode: 'icacls', reason: '无法确定当前用户' };
  const r = ex.runDetail('icacls', [dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F'], { stdio: 'ignore', timeoutMs: 10000 });
  return r.ok
    ? { ok: true, mode: 'icacls-dir' }
    : { ok: false, mode: 'icacls-dir', reason: r.error || ('退出码 ' + r.code) };
}

function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, mode: 'mkdir', reason: e.message }; }
  return protectDir(dir);
}

function writePrivate(file, data) {
  try {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    const p1 = protectFile(tmp);
    if (p1 && p1.ok === false) { try { fs.rmSync(tmp, { force: true }); } catch {} return { ok: false, reason: 'protect(tmp): ' + (p1.reason || p1.mode), mode: p1.mode }; }
    fs.renameSync(tmp, file);
    const p2 = protectFile(file);
    if (p2 && p2.ok === false) return { ok: false, reason: 'protect(file): ' + (p2.reason || p2.mode), mode: p2.mode };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { protectFile, protectDir, ensurePrivateDir, writePrivate, hasIcacls, currentUser, IS_WINDOWS };
