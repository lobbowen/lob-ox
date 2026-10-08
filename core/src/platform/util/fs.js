'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

// 原子写：唯一落盘路径。tmp 名含 pid+毫秒防并发写者互踩；mode 只对新建文件生效，rename 后再 chmod 收口。
function writeAtomic(file, data, opts) {
  const mode = (opts && typeof opts.mode === 'number') ? opts.mode : 0o600;
  const fp = path.resolve(file);
  const dir = path.dirname(fp);
  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, data, { mode });
    // chmod 失败不构成写入失败（Windows 忽略 POSIX mode），但必须留痕——静默会让权限问题无法诊断。
    try { fs.chmodSync(tmp, mode); } catch (e) { chmodWarn(file, e); }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, mode); } catch (e) { chmodWarn(file, e); }
    return fp;
  } catch (e) {
    // 失败清理：必须 **unlink** 而非 truncate —— 后者会永久留下 0 字节 tmp 文件（P0 清理项）。
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {  }
    throw e;
  }
}

// 权限收口失败的统一记录口（不抛出：chmod 失败不影响数据已落盘这一事实）。
function chmodWarn(file, e) {
  try {
    console.warn('[fs] chmod 收口失败（数据已落盘，权限可能不符预期）: ' + file + ' — ' + ((e && e.message) || e));
  } catch { /* 记录失败也不得影响主流程 */ }
}

function removeTreeDeferred(dir, ms) {
  if (!dir) return null;
  const t = setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  } }, ms === undefined ? 60000 : ms);
  if (t.unref) t.unref();
  return t;
}

// 私有临时目录 0700：mode 显式给出，避免继承 umask 后同机他用户可读登录态。
function allocTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dsh-'));
  try { fs.chmodSync(dir, 0o700); } catch {  }
  return dir;
}

module.exports = { dirSizeBytes, writeAtomic, removeTreeDeferred, allocTempDir };
