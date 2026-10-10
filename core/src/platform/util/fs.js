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

module.exports = { dirSizeBytes, writeAtomic, removeTreeDeferred, allocTempDir };
