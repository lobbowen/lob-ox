'use strict';

// 端口注册表持久化（纯 IO）：read / atomic write / 只读聚合。记录结构：{ port, role, owner, createdAt }。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../util/fs');

/** 归一化一条记录；不合法返回 null。 */
function normRecord(r) {
  if (!r || !Number.isInteger(r.port) || !r.role) return null;
  return {
    port: r.port,
    role: r.role,
    owner: r.owner || null,
    createdAt: Number.isInteger(r.createdAt) ? r.createdAt : Date.now(),
  };
}

/** 读取并归一化注册表文件；缺失/损坏返回 []。 */
function loadRecords(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const out = [];
  for (const r of (Array.isArray(doc.records) ? doc.records : [])) {
    const n = normRecord(r);
    if (n) out.push(n);
  }
  return out;
}

/** 文件新鲜度指纹 `mtimeMs:size`；不存在返回 '0'。只用 mtime 会同毫秒双写撞值，
 *  追加记录必改 size，两维合相把漏检窗口压到必须「mtime 与 size 都恰好相同」。 */
function fileStamp(file) {
  try { const st = fs.statSync(file); return st.mtimeMs + ':' + st.size; } catch { return '0'; }
}

/** 原子写注册表（0600 + .tmp + rename）；失败不抛（内存态仍准确）。 */
function saveRecords(file, records) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify({ records }, null, 2), { mode: 0o600 });
  } catch { /* 持久化失败不阻塞运行 */ }
}

/** 只读聚合：同目录下其它注册表文件（文件名由调用方提供）。 */
function extraRecords(file, extraFiles) {
  const dir = path.dirname(file);
  const out = [];
  for (const f of (Array.isArray(extraFiles) ? extraFiles : [])) {
    if (typeof f !== 'string' || !f) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    for (const r of (Array.isArray(doc.records) ? doc.records : [])) {
      const n = normRecord(r);
      if (n) out.push(n);
    }
  }
  return out;
}

module.exports = { loadRecords, saveRecords, extraRecords, fileStamp };
