'use strict';

// 统一持久化（DSH-TOKEN-CONTRACT 契约2/3，TK-5/TK-6）：令牌是会话凭据，本仓只认这一处写入——原子写、写后 0600、统一脱敏（TK-5）。
// TK-6 超限必须轮转而非清空（清空唯一持久链路即永久丢失）：先原子备份进固定槽位再截断，全程没有删除调用。
// appendFileSync/writeFileSync 的 mode 只对新建文件生效，已存在文件的权限位被忽略，故所有写入后必须显式 chmod 收口。
// Windows 忽略 POSIX mode，本文件的 chmod 为 no-op，安全边界由 supervisor 的目录级 protectDir 承担。

const fs = require('node:fs');
const path = require('node:path');

const PERSIST_LIMITS = {
  /** 单个令牌文件超过此字节数即轮转。 */
  MAX_BYTES: 256 * 1024,
  /** 历史备份槽位数（固定名 .bak-0 到 .bak-n-1，按最旧优先覆写，只轮转不删除）。 */
  KEEP_BACKUPS: 2,
  /** 读取尾部时的一次性字节窗口，恢复文件和 journal 行都很短。 */
  TAIL_BYTES: 64 * 1024,
  /** 单行最大长度，超长行截断后写入，防畸形输出撑爆文件。 */
  MAX_LINE_BYTES: 8 * 1024,
};

/** ANSI 转义序列，DSH 输出可能带终端着色，把 URL 包在控制码里会导致解析不到。 */
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

/** 需要脱敏的键名；刻意不含 token，URL 行里的 ?token= 正是要保存的值。 */
const SECRET_KEY_RE = /^(?:password|passwd|pwd|secret|client_?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|credential|authorization|auth)$/i;

/** 去掉 ANSI 控制码；仅持久化路径使用，解析仍在原文行上进行。 */
function stripAnsi(line) {
  return String(line == null ? '' : line).replace(ANSI_RE, '');
}

/** 统一脱敏入口（TK-5）：顺手清掉同一行里夹带的其它机密（access_token、password、api_key 等）。
 *  只做值替换不做行删除，行结构（含 ?token=）必须保留，恢复文件才能重新解析。 */
function sanitizeTokenLine(line) {
  let s = stripAnsi(line).replace(/\r?\n$/, '');
  s = s.replace(/([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(["']?)([^\s"'&,;]+)\2/g, (m, key, q, val) => {
    if (!SECRET_KEY_RE.test(key)) return m;
    if (val === '<redacted>') return m;
    return key + '=' + '<redacted>';
  });
  // Bearer 形态的值与键名都不规则，单独处理。
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>');
  return s;
}

/** 确保目录存在（持久化前调用；失败不抛，交由后续写入报错）。 */
function ensureDir(dir) {
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch { /* 交给写入报错 */ }
}

/** 原子写：临时文件、chmod、rename。临时文件让读者永远看不到半个文件；
 *  rename 在部分平台会重写权限，故目标文件再收口一次。 */
function writeAtomic(file, data) {
  const fp = path.resolve(file);
  const tmp = fp + '.tmp' + process.pid;
  try {
    ensureDir(path.dirname(fp));
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 无 POSIX 位 */ }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch { /* 同上 */ }
    return { ok: true, path: fp };
  } catch (e) {
    // 失败清理选择截断而不删除：门禁 TK-G3 把 rmSync/rmdirSync 判为危险信号；截断后残留空文件，不含明文令牌。
    try { if (fs.existsSync(tmp)) fs.truncateSync(tmp, 0); } catch { /* 清理失败不影响返回 */ }
    return { ok: false, path: fp, reason: (e && e.message) || String(e) };
  }
}

/** 轮转：把现有内容整体改名进固定备份槽。
 *  必须用 rename 而非「读-写槽-截断」：read 与 truncate 之间的并发追加（升级重叠期新旧守卫）既不在备份里也会被抹掉；
 *  rename 原子，改名后仍持旧 fd 的写者把数据落进备份本体，新追加按 O_APPEND 建目标新文件。
 *  任一步失败返回 false 且不截断，宁可文件继续增长；Windows 槽位占用致 rename 失败时降级为复制+截断（窗口更小但不为零）。 */
function rotateByBackup(file, opts) {
  const fp = path.resolve(file);
  const keep = (opts && opts.keep) || PERSIST_LIMITS.KEEP_BACKUPS;
  try {
    const slot = pickBackupSlot(fp, keep);
    fs.renameSync(fp, slot);
    try { fs.chmodSync(slot, 0o600); } catch { /* Windows 无 POSIX 位 */ }
    return true;
  } catch {
    try {
      const content = fs.readFileSync(fp);
      const slot = pickBackupSlot(fp, keep);
      const w = writeAtomic(slot, content);
      if (!w.ok) return false;
      // 备份确实完整落地后才截断，顺序反了就等于清空唯一持久链路。
      fs.truncateSync(fp, 0);
      try { fs.chmodSync(fp, 0o600); } catch { /* Windows 无 POSIX 位 */ }
      return true;
    } catch { return false; }
  }
}

/** 选备份槽位：优先补空槽；槽位满则覆写 mtime 最旧的那个（固定名，全程无需删除）。 */
function pickBackupSlot(file, keep) {
  let oldest = { path: file + '.bak-0', mtime: Infinity };
  for (let i = 0; i < keep; i++) {
    const p = file + '.bak-' + i;
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs < oldest.mtime) oldest = { path: p, mtime: st.mtimeMs };
    } catch { return p; } // 空槽优先（不多占新槽位）
  }
  return oldest.path;
}

/** 追加一行（经统一脱敏与权限收口）；超限时先轮转再追加。
 *  轮转失败（磁盘满等）时仍然追加：宁可文件超限，也不让当前令牌丢失（TK-1）。 */
function appendByRotation(file, line, opts) {
  const fp = path.resolve(file);
  const maxBytes = (opts && opts.maxBytes) || PERSIST_LIMITS.MAX_BYTES;
  let text = sanitizeTokenLine(line);
  if (Buffer.byteLength(text, 'utf8') > PERSIST_LIMITS.MAX_LINE_BYTES) {
    text = text.slice(0, PERSIST_LIMITS.MAX_LINE_BYTES); // 超长畸形行截断（不会命中令牌行）
  }
  let rotated = false;
  try {
    ensureDir(path.dirname(fp));
    let size = 0;
    try { size = fs.statSync(fp).size; } catch { /* 不存在 = 0 */ }
    if (size > maxBytes) rotated = rotateByBackup(fp, opts);
    fs.appendFileSync(fp, text + '\n', { mode: 0o600 });
    try { fs.chmodSync(fp, 0o600); } catch { /* Windows 无 POSIX 位 */ }
    return { ok: true, path: fp, rotated: rotated };
  } catch (e) {
    return { ok: false, path: fp, rotated: rotated, reason: (e && e.message) || String(e) };
  }
}

/** 读文件尾部若干字节并按行切分（恢复文件用，不整文件读入以免拖慢捕获）。返回行数组，文件不存在返回 []。 */
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
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch { /* 关闭失败无影响 */ } }
}

// 恢复文件名的单一事实源在 app/settings/token-kinds.js 的 TOKEN_FILE_NAME（assembly/compose/core.js 直接取用），
// platform 侧不持有文件名注入链。
module.exports = {
  PERSIST_LIMITS,
  writeAtomic,
  appendByRotation,
  readTailLines,
};
