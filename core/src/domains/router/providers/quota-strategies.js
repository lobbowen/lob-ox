'use strict';

// 配额策略注册表：模式层（direct/proxy）只管生命周期与运输，本层负责「官方配额面 -> 统一 quota 结构」的取数与解析。
// 供应商在 proxy-apps.js / PROVIDER_PRESETS 用 quota.type 声明引用；同形态复用 type，形态不同才新增策略函数。
// 策略统一返回 { ok, quota }，quota 不含 overallStatus。

const { normalizeResetTs } = require('./policies/quota');

/** Command 默认 API 根（订阅面与 credits 面同主机）。 */
const DEFAULT_API_BASE = 'https://api.commandcode.ai';
const SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions';
/** 订阅信息重探周期（ms）：periodEnd 仅在续订/取消/变动时变化，低频即可（防高频 billing API 触发风控）。 */
const SUBSCRIPTION_REFETCH_MS = 6 * 3600 * 1000;
/** 月度重置调度可靠性上限：periodEnd 超过该时长视为不可靠（订阅异常），回退周期轮询。 */
const MONTHLY_RESET_MAX_AHEAD_MS = 45 * 24 * 3600 * 1000;

/** usage 面解析（窗口原样归一；percent 是否取整由调用方经 roundPercent 指定）。 */
async function detectWindowUsage(ctx) {
  const { url, key, timeout, roundPercent } = ctx || {};
  const init = { signal: AbortSignal.timeout(timeout || 12000) };
  if (key) init.headers = { Authorization: 'Bearer ' + key, Accept: 'application/json' };
  const res = await fetch(url, init);
  const j = res.ok ? await res.json() : null;
  if (!j) return { ok: false, error: '无法获取配额（HTTP ' + (res.status || '?') + '）' };
  const u = j.usage || j;
  const pick = (w) => (w && typeof w === 'object')
    ? {
        status: typeof w.status === 'string' ? w.status : null,
        percent: Number.isFinite(Number(w.percent)) ? (roundPercent ? Math.round(Number(w.percent)) : Number(w.percent)) : null,
        resetsAt: normalizeResetTs(w.resetsAt),
      }
    : null;
  return { ok: true, quota: { rolling: pick(u.rolling), weekly: pick(u.weekly), monthly: pick(u.monthly) } };
}

/** Command billing 面解析：窗口耗尽只由 used>=cap 推导，不依赖 exceeded 标志（上游对 100% 窗口可能不返该标志）。
 *  credits 原体无 period 字段，月度重置精确时刻只在 subscriptions 的 currentPeriodEnd：
 *  仅 credits-limited 账号取订阅（其它账号零额外 API），cache._subCheckedAt 做 6h 缓存；非 limited 清空 monthlyResetAt（不留陈旧日期）。
 *  ctx = { key, quota, cache, prevQuota }。 */
async function detectCommandCodeBilling(ctx) {
  const q = (ctx && ctx.quota) || {};
  const key = (ctx && ctx.key) || '';
  const cache = (ctx && ctx.cache) || null;
  const base = (q.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const res = await fetch(base + (q.creditsPath || '/alpha/billing/credits'), { signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  const j = res.ok ? await res.json() : null;
  // 信封兼容：上游可能返回 { data: { credits, windowLimits } } 或直接平铺
  const body = (j && typeof j === 'object' && j.data && typeof j.data === 'object' && (j.data.windowLimits || j.data.credits)) ? j.data : j;
  if (!body || !body.windowLimits) return { ok: false, error: '无法获取配额' };
  const wl = body.windowLimits;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const mapW = (name) => {
    const w = name ? wl[name] : null;
    if (!w || typeof w !== 'object') return null;
    const cap = num(w.cap), used = num(w.used);
    let pct = null;
    if (cap !== null && used !== null && cap > 0 && used >= 0) pct = Math.min(100, Math.round((used / cap) * 100));
    else if (w.exceeded === true || w.exceeded === 1 || w.exceeded === 'true') pct = 100;
    if (pct === null) return null;
    return { status: pct >= 100 ? 'rate-limited' : 'ok', percent: pct, resetsAt: normalizeResetTs(w.resetAt) };
  };
  const wm = q.windowMap || {};
  const cr = body.credits || {};
  const monthlyRemaining = [cr.monthlyCredits, cr.purchasedCredits, cr.freeCredits]
    .reduce((s, v) => { const n = num(v); return n !== null && n >= 0 ? s + n : s; }, 0);
  const hasCredits = cr.monthlyCredits !== undefined || cr.purchasedCredits !== undefined || cr.freeCredits !== undefined || cr.belowThreshold !== undefined;
  // 月度重置：仅 credits-limited 取订阅；非 limited -> 清空 monthlyResetAt。
  // creditLow 并入 ctx.creditFrozen（上游 400 拒绝驱动的冻结）：冻结期间必须持续掌握 periodEnd 以呈现/调度
  // 精确恢复时刻——余额灰区（>0 但不足服务）单靠数据面永远测不到。
  const creditLow = (hasCredits && ((typeof cr.monthlyCredits === 'number' && cr.monthlyCredits <= 0)
    || cr.belowThreshold === true
    || (Number.isFinite(Number(monthlyRemaining)) && Number(monthlyRemaining) <= 0)))
    || (ctx && ctx.creditFrozen === true);
  const prevReset = (ctx && ctx.prevQuota && ctx.prevQuota.monthlyResetAt) || null;
  let monthlyResetAt = null;
  if (creditLow) {
    if (!cache || !cache._subCheckedAt || Date.now() - cache._subCheckedAt >= SUBSCRIPTION_REFETCH_MS) {
      if (cache) cache._subCheckedAt = Date.now(); // 先打点再取：失败也不逐轮轰炸上游
      try {
        const subRes = await fetch(base + (q.subscriptionsPath || SUBSCRIPTIONS_PATH), { signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
        const sj = subRes.ok ? await subRes.json() : null;
        const sdata = (sj && typeof sj === 'object' && sj.data && typeof sj.data === 'object' && sj.data.currentPeriodEnd) ? sj.data : (sj || null);
        if (sdata && typeof sdata === 'object') {
          const end = normalizeResetTs(sdata.currentPeriodEnd);
          const unreliable = sdata.cancelAtPeriodEnd === true || sdata.status === 'canceled' || sdata.status === 'past_due' || sdata.status === 'unpaid';
          // 仅「活跃、未设取消、未来且不过远」的 periodEnd 才当精确恢复点，否则回退轮询
          if (end && !unreliable && end > Date.now() && end - Date.now() <= MONTHLY_RESET_MAX_AHEAD_MS) monthlyResetAt = end;
        }
      } catch { /* 订阅查询失败：本轮无 monthlyResetAt（回退轮询），不影响主额度流程 */ }
    } else {
      monthlyResetAt = prevReset; // 缓存期内沿用上次已知 periodEnd（不重复取）
    }
  }
  // 月度窗口推导：Command 订阅含月配额池（monthlyCapUsd），周窗口从池内扣；
  // 池存在且 monthlyRemaining 可数时推导 monthly={percent,resetsAt}，供前端每月格子显示真实百分比。
  const monthlyCap = q.monthlyCapUsd ? num(q.monthlyCapUsd) : null;
  const derivedMonthly = (hasCredits && monthlyCap !== null && Number.isFinite(Number(monthlyRemaining)) && monthlyRemaining >= 0)
    ? (() => {
        const used = Math.min(monthlyCap, Math.max(0, monthlyCap - monthlyRemaining));
        const pct = monthlyCap > 0 ? Math.min(100, Math.round((used / monthlyCap) * 100)) : 0;
        return { status: pct >= 100 ? 'rate-limited' : 'ok', percent: pct, resetsAt: monthlyResetAt || undefined };
      })()
    : mapW(wm.monthly);
  return {
    ok: true,
    quota: {
      rolling: mapW(wm.rolling), weekly: mapW(wm.weekly), monthly: derivedMonthly,
      monthlyRemaining: hasCredits ? monthlyRemaining : null,
      monthlyResetAt, // epoch ms；无期/不可靠/非 limited -> null
      credits: hasCredits ? {
        monthlyCredits: num(cr.monthlyCredits),
        purchasedCredits: num(cr.purchasedCredits),
        freeCredits: num(cr.freeCredits),
        belowThreshold: cr.belowThreshold === true,
        creditThreshold: num(cr.creditThreshold),
      } : null,
      globalLimited: !!(wl && wl.limited) || null,
    },
  };
}

/** 注册表：type 到策略。kind 供模式类分派（official-billing 官方 API / window-usage 本地或官方 usage 面）。 */
const STRATEGIES = {
  'commandcode-billing': { kind: 'official-billing', detect: detectCommandCodeBilling },
  'window-usage': { kind: 'window-usage', detect: detectWindowUsage },
  // 兼容别名（持久化 adapter.quota 或旧注册表里的 type 保持不变即可工作）
  'opencode-usage': { kind: 'window-usage', detect: detectWindowUsage },
  'proxy-usage': { kind: 'window-usage', detect: detectWindowUsage },
};

function getQuotaStrategy(type) {
  return (type && STRATEGIES[type]) || null;
}

module.exports = { getQuotaStrategy };
