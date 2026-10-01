'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../util/fs');

function migrateByOwnerPrefix(oldFile, newFile, prefixes) {
  const pre = (Array.isArray(prefixes) ? prefixes : [])
    .filter((x) => typeof x === 'string' && x !== '');
  if (!pre.length) return 0;
  const matches = (r) => { const o = String((r && r.owner) || ''); return pre.some((p) => o.startsWith(p)); };
  if (!fs.existsSync(oldFile)) return 0;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(oldFile, 'utf8')); } catch { return 0; }
  if (!doc || !Array.isArray(doc.records)) return 0;
  const picks = doc.records.filter(matches);
  if (!picks.length) return 0;
  let target = { records: [] };
  let targetExisted = false;
  if (fs.existsSync(newFile)) {
    targetExisted = true;
    try {
      target = JSON.parse(fs.readFileSync(newFile, 'utf8'));
    } catch (e) {
      if (e instanceof SyntaxError) return 0;
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
    if (!targetExisted && fs.existsSync(newFile)) { try { fs.unlinkSync(newFile); } catch {  } }
    try { writeAtomic(oldFile, JSON.stringify(doc, null, 2), { mode: 0o600 }); } catch {  }
    throw e;
  }
  return moved;
}

module.exports = { migrateByOwnerPrefix };
