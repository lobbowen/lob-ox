'use strict';

// 令牌唯一写入点：原子写 + 写后显式 chmod（write 的 mode 只对新建文件生效）+ 脱敏。
// 超限必须轮转而非清空（清空唯一持久链路即永久丢失）；Windows 忽略 POSIX mode，安全边界由目录级 protectDir 承担。

const fs = require('node:fs');
const path = require('node:path');

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

function writeAtomic(file, data) {
  const fp = path.resolve(file);
  const tmp = fp + '.tmp' + process.pid;
  try {
    ensureDir(path.dirname(fp));
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {  }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch {  }
    return { ok: true, path: fp };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.truncateSync(tmp, 0); } catch {  }
    return { ok: false, path: fp, reason: (e && e.message) || String(e) };
  }
}

function rotateByBackup(file, opts) {
  const fp = path.resolve(file);
  const keep = (opts && opts.keep) || PERSIST_LIMITS.KEEP_BACKUPS;
  try {
    const slot = pickBackupSlot(fp, keep);
    fs.renameSync(fp, slot);
    try { fs.chmodSync(slot, 0o600); } catch {  }
    return true;
  } catch {
    try {
      const content = fs.readFileSync(fp);
      const slot = pickBackupSlot(fp, keep);
      const w = writeAtomic(slot, content);
      if (!w.ok) return false;
      fs.truncateSync(fp, 0);
      try { fs.chmodSync(fp, 0o600); } catch {  }
      return true;
    } catch { return false; }
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
  try {
    ensureDir(path.dirname(fp));
    let size = 0;
    try { size = fs.statSync(fp).size; } catch {  }
    if (size > maxBytes) rotated = rotateByBackup(fp, opts);
    fs.appendFileSync(fp, text + '\n', { mode: 0o600 });
    try { fs.chmodSync(fp, 0o600); } catch {  }
    return { ok: true, path: fp, rotated: rotated };
  } catch (e) {
    return { ok: false, path: fp, rotated: rotated, reason: (e && e.message) || String(e) };
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
  writeAtomic,
  appendByRotation,
  readTailLines,
};
