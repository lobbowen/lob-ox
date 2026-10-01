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
    try { fs.chmodSync(tmp, mode); } catch {  }
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, mode); } catch {  }
    return fp;
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.truncateSync(tmp, 0); } catch {  }
    throw e;
  }
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
