'use strict';

const { ProviderBase } = require('./base');
const { getQuotaStrategy } = require('./quota-strategies');

class DirectProvider extends ProviderBase {
  constructor(opts) {
    super(opts);
    this.kind = 'direct';
    this.baseUrl = opts.baseUrl || '';
    this.plan = opts.plan || { per5hUsd: null, weeklyUsd: null, monthlyUsd: null };
    this.pricing = opts.pricing || {};
    this.adapter = opts.adapter || null;
    this.presetId = opts.presetId || null;
    this.officialPricing = {};
  }

  supports(_cap) { return false; }

  pricingOf(_fallback) { return this.officialPricing || null; }

  async detectAccount(acc) {
    const quota = (this.adapter && this.adapter.quota) || {};
    const strategy = quota && getQuotaStrategy(quota.type);
    if (strategy && strategy.kind === 'official-billing') {
      return { ok: true, quota: null, unsupported: 'official-billing（direct 模式不支持直连官方 billing 面；该配额策略需 process-pool 模式）' };
    }
    if (!strategy || strategy.kind !== 'window-usage') return { ok: true, quota: null };
    const base = (this.baseUrl || '').replace(/\/$/, '');
    const url = base + (quota.usagePath || '/usage');
    const det = await strategy.detect({ url, key: acc.key, timeout: 12000, roundPercent: false }).catch((e) => ({ ok: false, error: e.message }));
    if (!det.ok) return det;
    return { ok: true, quota: det.quota || null };
  }
}

module.exports = { DirectProvider };
