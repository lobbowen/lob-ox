'use strict';

const { normalizeResetTs } = require('./policies/quota');

const DEFAULT_API_BASE = 'https://api.commandcode.ai';
const SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions';
const SUBSCRIPTION_REFETCH_MS = 6 * 3600 * 1000;
const MONTHLY_RESET_MAX_AHEAD_MS = 45 * 24 * 3600 * 1000;

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

async function detectCommandCodeBilling(ctx) {
  const q = (ctx && ctx.quota) || {};
  const key = (ctx && ctx.key) || '';
  const cache = (ctx && ctx.cache) || null;
  const base = (q.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const res = await fetch(base + (q.creditsPath || '/alpha/billing/credits'), { signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  const j = res.ok ? await res.json() : null;
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
  const creditLow = (hasCredits && ((typeof cr.monthlyCredits === 'number' && cr.monthlyCredits <= 0)
    || cr.belowThreshold === true
    || (Number.isFinite(Number(monthlyRemaining)) && Number(monthlyRemaining) <= 0)))
    || (ctx && ctx.creditFrozen === true);
  const prevReset = (ctx && ctx.prevQuota && ctx.prevQuota.monthlyResetAt) || null;
  let monthlyResetAt = null;
  if (creditLow) {
    if (!cache || !cache._subCheckedAt || Date.now() - cache._subCheckedAt >= SUBSCRIPTION_REFETCH_MS) {
      if (cache) cache._subCheckedAt = Date.now();
      try {
        const subRes = await fetch(base + (q.subscriptionsPath || SUBSCRIPTIONS_PATH), { signal: AbortSignal.timeout(5000), headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
        const sj = subRes.ok ? await subRes.json() : null;
        const sdata = (sj && typeof sj === 'object' && sj.data && typeof sj.data === 'object' && sj.data.currentPeriodEnd) ? sj.data : (sj || null);
        if (sdata && typeof sdata === 'object') {
          const end = normalizeResetTs(sdata.currentPeriodEnd);
          const unreliable = sdata.cancelAtPeriodEnd === true || sdata.status === 'canceled' || sdata.status === 'past_due' || sdata.status === 'unpaid';
          if (end && !unreliable && end > Date.now() && end - Date.now() <= MONTHLY_RESET_MAX_AHEAD_MS) monthlyResetAt = end;
        }
      } catch {  }
    } else {
      monthlyResetAt = prevReset;
    }
  }
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
      monthlyResetAt,
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

const STRATEGIES = {
  'commandcode-billing': { kind: 'official-billing', detect: detectCommandCodeBilling },
  'window-usage': { kind: 'window-usage', detect: detectWindowUsage },
  'opencode-usage': { kind: 'window-usage', detect: detectWindowUsage },
  'proxy-usage': { kind: 'window-usage', detect: detectWindowUsage },
};

function getQuotaStrategy(type) {
  return (type && STRATEGIES[type]) || null;
}

module.exports = { getQuotaStrategy };
