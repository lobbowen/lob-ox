'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fsUtil = require('../../util/fs');

const PERSIST_LIMITS = {
  MAX_BYTES: 256 * 1024,
  KEEP_BACKUPS: 2,
  TAIL_BYTES: 64 * 1024,
  MAX_LINE_BYTES: 8 * 1024,
};

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

const SECRET_KEY_RE = /^(?:password|passwd|pwd|secret|client_?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|authorization|auth)$/i;

function stripAnsi(line) {
  return String(line == null ? '' : line).replace(ANSI_RE, '');
}

function sanitizeTokenLine(line) {
  let s = stripAnsi(line).replace(/\r?\n$/, '');
  s = s.replace(/([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(["']?)([^\s"'&,;]+)\2/g, (m, key, q, val) => {
    if (!SECRET_KEY_RE.test(key)) return m;
    if (val === '<redacted>') return m;
    return key + '=' + '<redacted>';
  });
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>');
  return s;
}

function ensureDir(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch {  }
}

// R4/R8：删除本模块自带的 writeAtomic 副本（全项目曾有四份重复实现），
// 统一委托平台层 util/fs。token 池是凭据账本，必须 durable。
function writeDurable(file, data) {
  try {
    fsUtil.writeDurable(file, data, { mode: 0o600 });
    return { ok: true, path: path.resolve(file) };
  } catch (e) {
    return { ok: false, path: path.resolve(file), reason: (e && e.message) || String(e) };
  }
}

function chmodWarn(file, e) {
  try {
    console.warn('[token] chmod 收口失败（数据已落盘，权限可能不符预期）: ' + file + ' — ' + ((e && e.message) || e));
  } catch {  }
}

// 返回 { ok, reason }，而不是裸布尔。
// 此前失败一律 return false 且原因被 catch{} 吞掉，调用方只看到「轮转没发生」
// 却拿不到任何线索 —— rename 失败在 Windows 文件占用/杀软锁下是常见路径。
function rotateByBackup(file, opts) {
  const fp = path.resolve(file);
  const keep = (opts && opts.keep) || PERSIST_LIMITS.KEEP_BACKUPS;
  try {
    const slot = pickBackupSlot(fp, keep);
    fs.renameSync(fp, slot);
    try { fs.chmodSync(slot, 0o600); } catch {  }
    return { ok: true, slot };
  } catch (renameErr) {
    // rename 不可用（跨卷 / Windows 文件占用）：退回复制+截断。
    // 必须走与主路径同一个写入口 fsUtil.writeDurable —— 此前这里写的是
    // 裸 writeAtomic，而该标识符在本模块从未被导入，恒 ReferenceError，
    // 又被本函数的 catch 吞掉：轮转在 rename 失败时永不发生，账本无限增长。
    try {
      const content = fs.readFileSync(fp);
      const slot = pickBackupSlot(fp, keep);
      const w = writeDurable(slot, content);
      if (!w.ok) return { ok: false, reason: 'backup write failed: ' + (w.reason || '') + ' (rename: ' + ((renameErr && renameErr.message) || renameErr) + ')' };
      fs.truncateSync(fp, 0);
      try { fs.chmodSync(fp, 0o600); } catch {  }
      return { ok: true, slot };
    } catch (copyErr) {
      return { ok: false, reason: 'rotation failed: ' + ((copyErr && copyErr.message) || copyErr) + ' (rename: ' + ((renameErr && renameErr.message) || renameErr) + ')' };
    }
  }
}

function pickBackupSlot(file, keep) {
  let oldest = { path: file + '.bak-0', mtime: Infinity };
  for (let i = 0; i < keep; i++) {
    const p = file + '.bak-' + i;
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < oldest.mtime) oldest = { path: p, mtime: st.mtimeMs };
    } catch { return p; }
  }
  return oldest.path;
}

function appendByRotation(file, line, opts) {
  const fp = path.resolve(file);
  const maxBytes = (opts && opts.maxBytes) || PERSIST_LIMITS.MAX_BYTES;
  let text = sanitizeTokenLine(line);
  if (Buffer.byteLength(text, 'utf8') > PERSIST_LIMITS.MAX_LINE_BYTES) {
    text = text.slice(0, PERSIST_LIMITS.MAX_LINE_BYTES);
  }
  let rotated = false;
  let rotateReason = null;
  try {
    ensureDir(path.dirname(fp));
    let size = 0;
    try { size = fs.statSync(fp).size; } catch {  }
    if (size > maxBytes) {
      // rotateByBackup 返回 {ok,reason}。轮转失败时账本仍会继续追加而不停增长，
      // 因此把原因透出到返回值，让调用方能观测到「已超限但轮转未生效」。
      const r = rotateByBackup(fp, opts);
      rotated = !!(r && r.ok);
      rotateReason = (r && r.ok) ? null : ((r && r.reason) || 'rotation failed');
    }
    fs.appendFileSync(fp, text + '\n', { mode: 0o600 });
    try { fs.chmodSync(fp, 0o600); } catch {  }
    return { ok: true, path: fp, rotated, rotateReason };
  } catch (e) {
    return { ok: false, path: fp, rotated, rotateReason, reason: (e && e.message) || String(e) };
  }
}

function readTailLines(file, opts) {
  const fp = path.resolve(file);
  const bytes = (opts && opts.bytes) || PERSIST_LIMITS.TAIL_BYTES;
  let fd;
  try {
    if (!fs.existsSync(fp)) return [];
    fd = fs.openSync(fp, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, bytes);
    if (len <= 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len));
    return String(buf).split(/\r?\n/);
  } catch { return []; }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {  } }
}

module.exports = {
  PERSIST_LIMITS,
  writeDurable,
  appendByRotation,
  readTailLines,
};
