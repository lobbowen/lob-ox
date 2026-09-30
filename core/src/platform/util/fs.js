'use strict';

// 通用文件系统工具（与业务无关，供各域复用）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


/** 同步统计目录体积（字节）。有界：最多遍历 200k 条目；符号链接跳过（防循环与双计）。 */
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
      if (en.isSymbolicLink()) continue; // 链接不递归（防循环）；其目标体积由真实目录统计
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

/** 原子写：状态/配置文件的唯一落盘路径（各调用点不得自行实现 tmp+rename）。
 *  tmp 名含 pid+毫秒：并发写者各用各的临时文件，rename 只落在完整内容上；mode 默认 0600（令牌/URL 类不得 0644），
 *  writeFileSync 的 mode 只对新文件生效且 rename 在部分平台重写权限，故 rename 后再 chmod 收口。
 *  失败抛出（非返回 false）；抛前把 tmp 截 0 而非 unlink——TK-G3 判 rmSync 危险，截断也不误删并发写者刚换名的文件。 */
function writeAtomic(file, data, opts) {
  const mode = (opts && typeof opts.mode === 'number') ? opts.mode : 0o600;
  const fp = path.resolve(file);
  const dir = path.dirname(fp);
  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, data, { mode });
    try { fs.chmodSync(tmp, mode); } catch { /* Windows 无 POSIX 权限位 */ }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, mode); } catch { /* 同上 */ }
    return fp;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.truncateSync(tmp, 0); } catch { /* 清理失败不掩盖原错 */ }
    throw e;
  }
}

/** 延迟递归删除（一次性、unref）：隔离登录用完的临时 profile 目录。
 *  定时器必须 unref，否则三十分钟的清理窗口会拖住进程退出；失败静默（临时目录由系统兜底）。 */
function removeTreeDeferred(dir, ms) {
  if (!dir) return null;
  const t = setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 已删或无权 */ } }, ms === undefined ? 60000 : ms);
  if (t.unref) t.unref();
  return t;
}

/** 分配一次性私有临时目录（0700）：隔离登录的 profile 唯一落盘口。
 *  mkdtempSync 保证名字不与人撞；mode 显式给出，避免继承 umask 后同机他用户可读登录态。 */
function allocTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-'));
  try { fs.chmodSync(dir, 0o700); } catch { /* Windows 无 POSIX 权限位 */ }
  return dir;
}

module.exports = { dirSizeBytes, writeAtomic, removeTreeDeferred, allocTempDir };
