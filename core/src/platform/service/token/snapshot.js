'use strict';

// 令牌池快照持久化（纯 IO，TK-5/TK-7）：loadTokens 仅回流 captured 分类，用户配置/派生/自签绝不回流。

const fs = require('node:fs');
const persist = require('./persist');
const kinds = require('./kinds');

/** 原子写入池快照；@returns {{ok:boolean, reason?:string}} */
function saveTokens(file, entries) {
  const tokens = {};
  for (const e of entries) {
    tokens[e.id] = { value: e.value, gen: e.gen, source: e.source, at: e.at, kind: e.kind };
  }
  return persist.writeAtomic(file, JSON.stringify({ schema: 1, tokens }, null, 2) + '\n');
}

/** 读回可加载的令牌条目（captured 分类且非空）；文件缺失/损坏返回 []。 */
function loadTokens(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const tokens = doc && doc.tokens;
  if (!tokens || typeof tokens !== 'object') return [];
  const out = [];
  for (const id of Object.keys(tokens)) {
    const t = tokens[id] || {};
    // 池文件中任何非 captured 分类一律不加载，否则配置值/派生值会经 get/list 回流。
    if (!kinds.isCaptured(t.kind)) continue;
    if (!t.value) continue;
    out.push({
      id,
      value: String(t.value),
      gen: Number(t.gen) || 1,
      source: t.source || 'pool-file',
      at: Number(t.at) || Date.now(),
      kind: t.kind,
    });
  }
  return out;
}

module.exports = { saveTokens, loadTokens };
