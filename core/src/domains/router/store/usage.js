'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../../platform/util/fs');
const input = require('../../../platform/util/input');

function defaults(t) {
  t.requests = t.requests || 0;
  t.promptTokens = t.promptTokens || 0;
  t.completionTokens = t.completionTokens || 0;
  t.totalTokens = t.totalTokens || 0;
  t.costUsd = t.costUsd || 0;
  t.errors = t.errors || 0;
  if (!t.byModel || typeof t.byModel !== 'object') t.byModel = {};
  if (!t.byKey || typeof t.byKey !== 'object') t.byKey = {};
  return t;
}

class UsageLedger {
  constructor(opts) {
    const o = opts || {};
    this.file = o.file || null;
    this.logger = o.logger || null;
    this._keyFingerprint = typeof o.keyFingerprint === 'function' ? o.keyFingerprint : ((k) => k);
    this._estimateCost = typeof o.estimateCost === 'function' ? o.estimateCost : (() => 0);
    this._canPersist = typeof o.canPersist === 'function' ? o.canPersist : (() => true);
    this.events = o.events || null;
    this.totals = null;
    this._writeDelayMs = typeof o.writeDelayMs === 'number' ? o.writeDelayMs : 1000;
    this._maxModelKeys = typeof o.maxModelKeys === 'number' ? o.maxModelKeys : 64;
    this._timer = null;
    this._dirty = false;
  }

  _modelKey(model) {
    return input.ledgerKey(model, { max: 128, empty: 'unknown', unsafe: '(other)' });
  }

  _bump(t, model) {
    const key = this._modelKey(model);
    let bm = t.byModel[key];
    if (!bm) {
      if (Object.keys(t.byModel).length >= this._maxModelKeys && key !== '(other)') {
        bm = t.byModel['(other)'] || (t.byModel['(other)'] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
      } else {
        bm = t.byModel[key] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
      }
    }
    return bm;
  }

  recordUsage(entry) {
    const t = this.load();
    t.requests += 1;
    t.promptTokens += entry.promptTokens;
    t.completionTokens += entry.completionTokens;
    t.totalTokens += entry.totalTokens;
    const bm = this._bump(t, entry.model);
    bm.requests += 1; bm.promptTokens += entry.promptTokens; bm.completionTokens += entry.completionTokens; bm.totalTokens += entry.totalTokens;
    const cost = this._estimateCost(entry);
    if (cost > 0) {
      t.costUsd = (t.costUsd || 0) + cost;
      bm.costUsd = (bm.costUsd || 0) + cost;
    }
    if (entry.key) {
      const kf = this._keyFingerprint(entry.key);
      const bk = t.byKey[kf] || (t.byKey[kf] = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 });
      bk.requests += 1; bk.promptTokens += entry.promptTokens; bk.completionTokens += entry.completionTokens; bk.totalTokens += entry.totalTokens;
      if (cost > 0) bk.costUsd = (bk.costUsd || 0) + cost;
    }
    this._scheduleWrite();
    if (this.events) this.events.append('router_usage', { model: entry.model, tokens: entry.totalTokens });
    return t;
  }

  recordError() {
    const t = this.load();
    t.errors = (t.errors || 0) + 1;
    this._scheduleWrite();
    return t.errors;
  }

  _scheduleWrite() {
    this._dirty = true;
    if (this._writeDelayMs <= 0) return this._writeTotals();
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._writeTotals();
    }, this._writeDelayMs);
    if (this._timer && this._timer.unref) this._timer.unref();
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (!this._dirty) return;
    this._writeTotals();
  }

  
  load() {
    if (this.totals) return this.totals;
    let t;
    try { t = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    if (!t || typeof t !== 'object') t = {};
    this.totals = defaults(t);
    return this.totals;
  }

  getUsage() {
    const t = this.load();
    const byModel = Object.entries(t.byModel || {}).map(([model, v]) => ({ model, ...v })).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 12);
    return { requests: t.requests, promptTokens: t.promptTokens, completionTokens: t.completionTokens, totalTokens: t.totalTokens, costUsd: t.costUsd, errors: t.errors || 0, byModel, byKey: t.byKey || {} };
  }

  _writeTotals() {
    try {
      if (typeof this._canPersist === 'function' && !this._canPersist()) return;
      const t = this.totals;
      if (!t || !this.file) return;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeAtomic(this.file, JSON.stringify(t), { mode: 0o600 });
      this._dirty = false;
    } catch {}
  }
}

module.exports = { UsageLedger };
