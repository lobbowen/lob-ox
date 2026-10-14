'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Windows 上 chmodSync 是空操作（POSIX 权限位不存在），必须走 icacls 收口 ACL，
// 否则 0o600 只是意图而非事实——同机其他用户仍可读凭据账本。
// 懒加载避免循环依赖（file-protect 不依赖本模块）。
let _fileProtect = null;
function fileProtect() {
  if (_fileProtect === null) {
    try { _fileProtect = require('../os/file-protect'); } catch { _fileProtect = false; }
  }
  return _fileProtect || null;
}

function dirSizeBytes(root) {
  let total = 0;
  let seen = 0;
  const MAX = 200000;
  const walk = (dir) => {
    if (seen > MAX) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      if (seen > MAX) return;
      const full = path.join(dir, en.name);
      if (en.isSymbolicLink()) continue;
      if (en.isDirectory()) walk(full);
      else if (en.isFile()) {
        try { const st = fs.statSync(full); total += st.size; } catch {}
      }
      seen++;
    }
  };
  try { walk(root); } catch {}
  return total;
}

function writeAtomic(file, data, opts) {
  const mode = (opts && typeof opts.mode === 'number') ? opts.mode : 0o600;
  const fp = path.resolve(file);
  const dir = path.dirname(fp);
  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, data, { mode });
    
    try { fs.chmodSync(tmp, mode); } catch (e) { chmodWarn(file, e); }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, mode); } catch (e) { chmodWarn(file, e); }
    return fp;
  } catch (e) {
    
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {  }
    throw e;
  }
}

// 持久化分级（R4）——平台层契约，调用方按数据性质选，不按个人偏好选：
//   writeAtomic  仅保证 rename 原子，不保证掉电后内容已落盘。用于**可重建**数据
//                （日志、market 缓存、proxy-instance 日志等）。
//   writeDurable  rename 前 fsync 文件、rename 后 fsync 目录，掉电后文件非空且完整。
//                用于**不可重建**的账本数据（instances.json / registry.json / ports.json /
//                watermark / providers.json / dsh-main.json / tasks.json）。
// 分级依据：数据能否从其他来源重建。能重建用 atomic，不能则必须 durable。

function fsyncDir(dir) {
  // 目录 fsync 保证 rename 本身落盘。部分平台（Windows）对目录 fsync 返回 EPERM/EINVAL，
  // 此时降级为不 fsync——已比完全不 fsync 好，且不因平台差异抛错阻断调用方。
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } catch (e) { if (e && e.code !== 'EPERM' && e.code !== 'EINVAL') throw e; }
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EINVAL')) return;
    // 打开失败等其他错误不阻断：durable 的核心价值在文件 fsync，目录 fsync 是加固。
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {  } }
  }
}

// 权限收口：POSIX 用 chmod（调用方已做），Windows 用 icacls。
// 失败只 warn 不抛：数据已落盘，权限不符预期不应让调用方以为写失败。
function enforceAcl(fp) {
  const fpx = fileProtect();
  if (!fpx || !fpx.IS_WINDOWS) return;
  try {
    const r = fpx.protectFile(fp);
    if (r && r.ok === false) {
      console.warn('[fs] ACL 收口失败（数据已落盘，同机其他用户可能可读）: ' + fp + ' — ' + (r.reason || r.mode));
    }
  } catch (e) {
    console.warn('[fs] ACL 收口异常: ' + fp + ' — ' + ((e && e.message) || e));
  }
}

function writeDurable(file, data, opts) {
  const mode = (opts && typeof opts.mode === 'number') ? opts.mode : 0o600;
  const fp = path.resolve(file);
  const dir = path.dirname(fp);
  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      try { fs.closeSync(fd); } catch {  }
    }
    try { fs.chmodSync(tmp, mode); } catch (e) { chmodWarn(file, e); }
    enforceAcl(tmp);
    fs.renameSync(tmp, fp);
    fsyncDir(dir);
    try { fs.chmodSync(fp, mode); } catch (e) { chmodWarn(file, e); }
    enforceAcl(fp);
    return fp;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {  }
    throw e;
  }
}

function chmodWarn(file, e) {
  try {
    console.warn('[fs] chmod 收口失败（数据已落盘，权限可能不符预期）: ' + file + ' — ' + ((e && e.message) || e));
  } catch {  }
}

function removeTreeDeferred(dir, ms) {
  if (!dir) return null;
  const t = setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  } }, ms === undefined ? 60000 : ms);
  if (t.unref) t.unref();
  return t;
}

function allocTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-'));
  try { fs.chmodSync(dir, 0o700); } catch {  }
  return dir;
}

module.exports = { dirSizeBytes, writeAtomic, writeDurable, removeTreeDeferred, allocTempDir };
