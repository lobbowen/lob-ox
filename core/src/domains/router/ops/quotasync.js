'use strict';

// 官方配额与单价同步（网络 IO）。deps 注入：{getProviders, findProvider, save, events, setPriceIndex}。

function createQuotaSyncOps(deps) {
  const d = deps || {};
  const getProviders = d.getProviders || (() => []);
  const findProvider = d.findProvider || (() => null);
  const save = d.save || (() => {});
  const events = d.events || null;
  const setPriceIndex = d.setPriceIndex || (() => {});

  async function refreshOfficialUsageAll() {
    for (const p of getProviders()) {
      if (p.supports('instanceLifecycle')) continue; // 额度探测按账号=无实例池的形态（process-pool 走实例面）
      for (const acc of p.accounts || []) {
        if (!acc.key) continue;
        try { const det = await p.detectAccount(acc); p.applyDetection(acc, det); } catch {}
      }
    }
  }

  async function refreshProviderQuota(providerId) {
    const p = findProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (!p.supports('instanceLifecycle')) {
      for (const acc of p.accounts || []) { if (!acc.key) continue; try { const det = await p.detectAccount(acc); p.applyDetection(acc, det); } catch {} }
    } else {
      for (const inst of p.instances || []) {
        try { const det = await p.detectInstanceQuota(inst); const acc = p.accountOf(inst); if (acc) p.applyDetection(acc, det); } catch {}
      }
    }
    save();
    if (events) events.append('provider_quota_refreshed', { provider: providerId });
    return { ok: true };
  }

  /* 官方单价同步（models.dev）：直连供应商按 adapter.pricing 源抓权威单价 + 全局模型定价索引
   * （反代/直连转发的任意官方模型按模型名查价，供费用估算）。 */
  async function refreshOfficialPricingAll() {
    const sources = new Map();
    for (const pr of getProviders()) {
      const ps = pr.adapter && pr.adapter.pricing;
      if (ps && ps.type === 'models-dev' && ps.provider) sources.set(ps.provider, ps.provider);
    }
    try {
      const j = await (await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20000) })).json();
      let directModels = 0;
      for (const provKey of sources.values()) {
        const go = j[provKey];
        const models = (go && go.models) ? go.models : (go || {});
        const pricing = {};
        for (const [mk, mv] of Object.entries(models)) {
          const c = mv && (mv.cost || mv.pricing);
          if (c && typeof c === 'object') {
            pricing[mk] = { input: (c.input !== undefined) ? Number(c.input) : 0, output: (c.output !== undefined) ? Number(c.output) : 0, cache_read: (c.cache_read !== undefined) ? Number(c.cache_read) : 0 };
            directModels++;
          }
        }
        for (const pr of getProviders()) {
          const ps = pr.adapter && pr.adapter.pricing;
          if (ps && ps.type === 'models-dev' && ps.provider === provKey) pr.officialPricing = pricing;
        }
      }
      const index = {};
      for (const [provKey, go] of Object.entries(j || {})) {
        const models = (go && go.models) ? go.models : (go || {});
        for (const [mk, mv] of Object.entries(models)) {
          if (index[mk]) continue;
          const c = mv && (mv.cost || mv.pricing);
          if (c && typeof c === 'object') {
            const input = (c.input !== undefined) ? Number(c.input) : 0;
            const output = (c.output !== undefined) ? Number(c.output) : 0;
            if (input > 0 || output > 0) index[mk] = { input, output };
          }
        }
      }
      setPriceIndex(index);
      save();
      return { ok: true, models: directModels, indexModels: Object.keys(index).length };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  return { refreshOfficialUsageAll, refreshProviderQuota, refreshOfficialPricingAll };
}

module.exports = { createQuotaSyncOps };
