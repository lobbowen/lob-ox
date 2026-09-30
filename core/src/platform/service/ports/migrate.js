'use strict';

// 通用端口记录迁移（纯 IO）：把 owner 命中任一前缀的记录从 oldFile 迁出到 newFile，并从旧文件清除。
// 平台只按 owner 前缀字符串工作，前缀由域侧提供（DS-G4）；目标合并去重（按 port）、幂等、原子写。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../util/fs');

/** owner 前缀迁移；@returns {number} 实际迁出的记录数。
 *  安全不变量：任何一侧 JSON 不可信即返回 0 且不碰文件（源损坏裸抛会崩启动路径；吞目标解析错误再清源会让记录两头无存）。
 *  顺序：先原子清源（tmp+rename）-> 再写目标；写目标失败则回写源并上抛——半途失败只会「少一份」，不会新旧双登记。 */
function migrateByOwnerPrefix(oldFile, newFile, prefixes) {
  const pre = (Array.isArray(prefixes) ? prefixes : [])
    .filter((x) => typeof x === 'string' && x !== '');
  if (!pre.length) return 0;
  const matches = (r) => { const o = String((r && r.owner) || ''); return pre.some((p) => o.startsWith(p)); };
  if (!fs.existsSync(oldFile)) return 0;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(oldFile, 'utf8')); } catch { return 0; } // 源损坏：幂等 no-op，绝不崩
  if (!doc || !Array.isArray(doc.records)) return 0;
  const picks = doc.records.filter(matches);
  if (!picks.length) return 0;
  let target = { records: [] };
  let targetExisted = false;
  if (fs.existsSync(newFile)) {
    targetExisted = true;
    // 只有 JSON 解析失败（SyntaxError）判「坏目标 -> no-op 保护」；读取本身的 IO 错误
    // （如目标是目录）视为空目标继续，让写入阶段暴露失败。
    try {
      target = JSON.parse(fs.readFileSync(newFile, 'utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) return 0; // 坏目标：不覆盖、不迁（留给上层报错）
      target = { records: [] };
    }
    if (!target || typeof target !== 'object' || !Array.isArray(target.records)) return 0;
  }
  const seen = new Set(target.records.map((r) => r && r.port));
  let moved = 0;
  for (const r of picks) { if (!seen.has(r.port)) { target.records.push(r); moved += 1; } }
  const keep = doc.records.filter((r) => !matches(r));
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  try {
    writeAtomic(oldFile, JSON.stringify({ records: keep }, null, 2), { mode: 0o600 });
    writeAtomic(newFile, JSON.stringify(target, null, 2), { mode: 0o600 });
  } catch (e) {
    if (!targetExisted && fs.existsSync(newFile)) { try { fs.unlinkSync(newFile); } catch { /* 尽力清理 */ } }
    try { writeAtomic(oldFile, JSON.stringify(doc, null, 2), { mode: 0o600 }); } catch { /* 回写失败：源已被原子清走 picks，无双登记风险 */ }
    throw e; // 半途失败必须上抛（调用方 ports-bootstrap 捕获记日志）
  }
  return moved;
}

module.exports = { migrateByOwnerPrefix };
