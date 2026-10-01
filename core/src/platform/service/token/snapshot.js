'use strict';

const fs = require('node:fs');
const persist = require('./persist');
const kinds = require('./kinds');

function saveTokens(file, entries) {
  const tokens = {};
  for (const e of entries) {
    tokens[e.id] = { value: e.value, gen: e.gen, source: e.source, at: e.at, kind: e.kind };
  }
  return persist.writeAtomic(file, JSON.stringify({ schema: 1, tokens }, null, 2) + '\n');
}

function loadTokens(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const tokens = doc && doc.tokens;
  if (!tokens || typeof tokens !== 'object') return [];
  const out = [];
  for (const id of Object.keys(tokens)) {
    const t = tokens[id] || {};
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
