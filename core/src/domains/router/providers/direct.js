'use strict';

// 直连 API 供应商：轻量，账号=API Key，上游=官方 OpenAI 兼容端点（多 Key 共享直连）。
// 检测按 adapter.quota.type 查配额策略注册表（quota-strategies.js）：window-usage（含别名
// opencode-usage）用官方 /usage 窗口面；无适配器（adapter=null）为响应驱动（不探测，靠上游
// 限额响应经转发层分类冻结）。模式类不携带供应商解析词。

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

  /** 能力声明：key-pool 无实例能力，显式声明「不支持」供调用方 supports() 守卫，差异可静态校验。 */
  supports(_cap) { return false; }

  /** 结算单价来源：直连=本供应商官方单价表（officialPricing，经单价同步刷新）。 */
  pricingOf(_fallback) { return this.officialPricing || null; }

  async detectAccount(acc) {
    const quota = (this.adapter && this.adapter.quota) || {};
    const strategy = quota && getQuotaStrategy(quota.type);
    // 不支持的能力面必须显式拒绝、不得静默降级：quota:null 会被误读为「该供应商无配额」，
    // 实际是 direct 模式不支持 official-billing（需 process-pool/反代模式）。
    if (strategy && strategy.kind === 'official-billing') {
      return { ok: true, quota: null, unsupported: 'official-billing（direct 模式不支持直连官方 billing 面；该配额策略需 process-pool 模式）' };
    }
    if (!strategy || strategy.kind !== 'window-usage') return { ok: true, quota: null };
    const base = (this.baseUrl || '').replace(/\/$/, '');
    const url = base + (quota.usagePath || '/usage');
    // 直连窗口 usage：12s 超时 + Bearer；percent 不取整（原样透传上游值）
    const det = await strategy.detect({ url, key: acc.key, timeout: 12000, roundPercent: false }).catch((e) => ({ ok: false, error: e.message }));
    if (!det.ok) return det;
    return { ok: true, quota: det.quota || null };
  }
}

module.exports = { DirectProvider };
