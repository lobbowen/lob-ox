'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../../platform/util/fs');

/**
 * 根因 E：缺新鲜度标记时**必须判为 stale**，不得伪造为新鲜。
 *
 * 修前：`const ts = cache && cache.indexedAt ? cache.indexedAt : Date.now();`
 * —— 无 indexedAt 时用当前时间 ⇒ getIndex 的 TTL 判定恒为"新鲜" ⇒ **索引永不刷新**，
 * 且 _view().indexedAt 报 0（UI 显示"从未索引"）与代码认知矛盾。
 */
function loadIndex(file) {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 无 indexedAt ⇒ ts = 0（stale），触发重建；绝不回退成 Date.now()。
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
