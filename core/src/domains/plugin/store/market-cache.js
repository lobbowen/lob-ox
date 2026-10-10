'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../../platform/util/fs');

function loadIndex(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    
    const ts = (cache && typeof cache.indexedAt === 'number') ? cache.indexedAt : 0;
    return { cache, ts };
  } catch { return null; }
}

function saveIndex(cacheDir, file, cache, logger) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    writeAtomic(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e) { logger.error && logger.error('market cache write fail ' + e.message); }
}

module.exports = { loadIndex, saveIndex };
