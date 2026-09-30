'use strict';

// 跨平台文件/目录访问保护。POSIX mode 在 Windows 被忽略（NTFS 用 ACL），故含 apiAccessKey/remoteToken/会话令牌的文件
// 在 Windows 必须另行收紧：icacls 移除继承并仅授当前用户（目录用 (OI)(CI) 让内部文件继承）。
// 全部 best-effort：失败不阻断主流程，但经返回值可观测。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ex = require('../util/exec');

const IS_WINDOWS = process.platform === 'win32';
let _icacls = null; // 缓存 icacls 可用性

function hasIcacls(platform) {
  if ((platform || process.platform) !== 'win32') return false;
  if (_icacls !== null) return _icacls;
  // 经统一执行器。必须用 runOut：execFileSync 在 stdio ignore 下成功也返回 null，
  // 用 !== null 判可用会恒 false，导致 icacls 收紧静默失效。
  _icacls = ex.runOut('icacls', ['/?'], { timeoutMs: 3000 }) !== null;
  return _icacls;
}

function currentUser() {
  return process.env.USERNAME || process.env.USER || (() => { try { return os.userInfo().username; } catch { return null; } })();
}

/** 保护单个文件（Unix chmod 0600；Windows icacls 仅当前用户）。
 *  @returns {{ok:boolean, mode:string, reason?:string}} */
function protectFile(file) {
  if (!IS_WINDOWS) {
    try { fs.chmodSync(file, 0o600); return { ok: true, mode: 'posix-0600' }; }
    catch (e) { return { ok: false, mode: 'posix-0600', reason: e.message }; }
  }
  if (!hasIcacls()) return { ok: false, mode: 'none', reason: 'icacls 不可用' };
  const user = currentUser();
  if (!user) return { ok: false, mode: 'icacls', reason: '无法确定当前用户' };
  // 经统一执行器：runDetail 保留退出码/错误，便于如实上报失败原因。
  const r = ex.runDetail('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore', timeoutMs: 5000 });
  return r.ok
    ? { ok: true, mode: 'icacls-file' }
    : { ok: false, mode: 'icacls-file', reason: r.error || ('退出码 ' + r.code) };
}

/** 保护目录（Unix chmod 0700；Windows icacls 继承性收紧 (OI)(CI)）。
 *  建议在数据目录创建后调用一次——内部新建文件自动继承约束。
 *  @returns {{ok:boolean, mode:string, reason?:string}} */
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

/** 写入敏感文件并施加保护（原子写 + 保护，避免写完到保护之间的可读窗口）；保护失败如实返回 ok:false。
 *  生产零调用点（仅测试套件使用）；真正生效的那一半是同目录 protectDir。
 *  @returns {{ok:boolean, reason?:string, mode?:string}} */
function writePrivate(file, data) {
  try {
    const dir = path.dirname(file);
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    const p1 = protectFile(tmp);
    if (p1 && p1.ok === false) { try { fs.rmSync(tmp, { force: true }); } catch {} return { ok: false, reason: 'protect(tmp): ' + (p1.reason || p1.mode), mode: p1.mode }; }
    fs.renameSync(tmp, file);
    const p2 = protectFile(file); // rename 后再次确保（部分平台 rename 不保留 ACL）
    if (p2 && p2.ok === false) return { ok: false, reason: 'protect(file): ' + (p2.reason || p2.mode), mode: p2.mode };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { protectFile, protectDir, ensurePrivateDir, writePrivate, hasIcacls, currentUser, IS_WINDOWS };
