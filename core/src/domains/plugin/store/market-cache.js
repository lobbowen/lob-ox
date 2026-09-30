'use strict';

// 插件市场索引磁盘缓存（IO 叶子）：读盘（真实 indexedAt TTL）与原子写盘。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../../platform/util/fs');

/** 读索引缓存；失败/缺失返回 null。_ts 用缓存真实 indexedAt（不得重置为 Date.now()）。 */
function loadIndex(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ts = cache && cache.indexedAt ? cache.indexedAt : Date.now();
    return { cache, ts };
  } catch { return null; }
}

/** 原子写索引缓存（mkdir -p + tmp + rename）。 */
function saveIndex(cacheDir, file, cache, logger) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    writeAtomic(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (e) { logger.error && logger.error('market cache write fail ' + e.message); }
}

module.exports = { loadIndex, saveIndex };
