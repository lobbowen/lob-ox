'use strict';

// 聚合流水位持久化（纯 IO）：读回数字水位；原子写（tmp + rename，失败只告警）。

const fs = require('node:fs');
const { writeAtomic } = require('../../util/fs');

// 从文件读回水位（仅数字键）；文件缺失/损坏静默。
function loadWatermark(file, sources, into) {
  try {
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const s of sources) if (typeof w[s.name] === 'number') into[s.name] = w[s.name];
  } catch {}
}

// 原子写水位到文件；失败只经 logger 告警。
function saveWatermark(dir, file, wm, logger) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, JSON.stringify(wm), { mode: 0o600 });
  } catch (e) { logger && logger.warn && logger.warn('[hub] watermark save: ' + (e && e.message)); }
}

module.exports = { loadWatermark, saveWatermark };
