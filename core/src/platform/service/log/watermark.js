'use strict';

const fs = require('node:fs');
const { writeAtomic } = require('../../util/fs');

function loadWatermark(file, sources, into) {
  try {
    const w = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const s of sources) if (typeof w[s.name] === 'number') into[s.name] = w[s.name];
  } catch {}
}

function saveWatermark(dir, file, wm, logger) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file, JSON.stringify(wm), { mode: 0o600 });
  } catch (e) { logger && logger.warn && logger.warn('[hub] watermark save: ' + (e && e.message)); }
}

module.exports = { loadWatermark, saveWatermark };
