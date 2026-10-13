'use strict';

// R5/D.5-P1-16：原 CREDIT_KEYWORDS 末尾是裸词 'balance'，导致错误体含 balance
// 子串（load balance、unbalanced token）即被判 credits 耗尽，账号被冻结 10 分钟
// 轮询，而真实的 5xx 本应走 transient 重试。误冻结直接打穿可用账号数。
// 修为短语加共现规则：credits 判定必须同时出现「余额/额度不足」语义与金额或
// 余额语义之一，单独 balance 不足以触发。
const QUOTA_KEYWORDS = ['insufficient_quota','quota_exceeded','quota reached','usage limit','5-hour usage limit','5 hour usage limit','monthly limit','weekly limit','gousagelimiterror','out of quota','quota has been exceeded'];

// 第一组：明确的「不足」表述（短语，非裸词）
const CREDIT_EXHAUSTED = [
  'insufficient credit','insufficient credits','insufficient balance','credit balance',
  'no credits','out of credit','out of credits','purchase credits','purchase more credits',
  'add credits','billing error','insufficient funds','payment required','quota exceeded for billing',
];
// 第二组：余额语义（单独出现不足以判定，须与第一组共现）
const BALANCE_TERMS = ['balance','credit','credits','funds','billing'];

function classifyUpstreamLimited(status, text) {
  const lower = String(text || '').toLowerCase();
  const has = (kws) => kws.some((kw) => lower.includes(kw));
  // 402 是协议级的 payment required，无需文本判据。
  if (status === 402) return 'credits';
  // 明确的不足短语，单独即可判定。
  if (has(CREDIT_EXHAUSTED)) return 'credits';
  // 只有余额语义词而不足短语缺失时，要求「不足语义 + 余额语义」共现，
  // 避免 load balance / unbalanced token 这类无关文本误触发。
  const INSUFFICIENT_TERMS = ['insufficient','exceeded','exhausted','depleted','not enough','ran out','out of'];
  if (has(INSUFFICIENT_TERMS) && has(BALANCE_TERMS)) return 'credits';
  if (has(QUOTA_KEYWORDS)) return 'window';
  if (status >= 500 && status <= 599) return 'transient';
  if (status === 401 || status === 403) return 'banned';
  return 'none';
}

const { headerRetryMs, bodyResetMs } = require('../../policies/failure');

function normalizeResetTs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d{1,13}$/.test(String(v).trim())) {
    let n = typeof v === 'number' ? v : Number(String(v).trim());
    if (!Number.isFinite(n)) return null;
    if (n < 1e12) n *= 1000;
    return n;
  }
  const t = Date.parse(String(v).trim());
  return Number.isFinite(t) ? t : null;
}

function fmtClock(ms) {
  try {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch { return ''; }
}

function isQuotaCreditsLow(q) {
  if (!q) return false;
  const c = q.credits;
  if (c) {
    if (c.belowThreshold === true) return true;
    if (typeof c.monthlyCredits === 'number' && Number.isFinite(c.monthlyCredits) && c.monthlyCredits <= 0) return true;
  }
  const rem = q.monthlyRemaining;
  return typeof rem === 'number' && Number.isFinite(rem) && rem <= 0;
}

function quotaOverallStatus(q) {
  if (!q) return '正常';
  if (isQuotaCreditsLow(q)) return '额度用尽';
  const ex = (w) => w && (w.status === 'rate-limited' || (Number.isFinite(Number(w.percent)) && Number(w.percent) >= 100));
  const monthlyEx = ex(q.monthly), weeklyEx = ex(q.weekly), rollingEx = ex(q.rolling);
  if (monthlyEx || (weeklyEx && rollingEx)) return '用尽';
  if (weeklyEx) return '周限额';
  if (rollingEx) return '5h限额';
  return '正常';
}

function monthlyResetAtOf(acc) {
  const q = (acc && acc.quota) || {};
  const v = Number(q && q.monthlyResetAt);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v > Date.now() ? v : 0;
}

function accountQuotaSummary(acc) {
  const q = (acc && acc.quota) || {};
  const win = (w) => (w ? { percent: w.percent ?? null, status: w.status || null, resetsAt: w.resetsAt || null } : null);
  return { rolling: win(q.rolling), weekly: win(q.weekly), monthly: win(q.monthly), overall: q.overallStatus || null };
}

function windowFull(w) {
  return !!w && (w.status === 'rate-limited' || (Number.isFinite(Number(w.percent)) && Number(w.percent) >= 100));
}

function windowExhausted(acc) {
  const sum = accountQuotaSummary(acc);
  return [sum.rolling, sum.weekly, sum.monthly].some((w) => w && (w.status === 'rate-limited' || (w.percent !== null && w.percent >= 100)));
}

function nextResetAt(quota) {
  const q = quota || {};
  let soonest = null;
  let precise = false;
  for (const [key, w] of [['rolling', q.rolling], ['weekly', q.weekly], ['monthly', q.monthly]]) {
    if (!w) continue;
    if (!windowFull(w)) continue;
    let t = normalizeResetTs(w.resetsAt);
    if (t && t > 0) precise = true;
    else t = Date.now() + (key === 'rolling' ? 5 * 3600 * 1000 : key === 'weekly' ? 7 * 24 * 3600 * 1000 : 30 * 24 * 3600 * 1000);
    if (soonest === null || t < soonest) soonest = t;
  }
  return { t: soonest, precise };
}

function creditsResetDue(acc, now) {
  if (!acc) return false;
  const N = now || Date.now();
  const cands = [acc.nextResetAt, acc.limit && acc.limit.recovery && acc.limit.recovery.at, acc.quota && acc.quota.monthlyResetAt];
  for (const v of cands) {
    const t = Number(v);
    if (Number.isFinite(t) && t > 0 && t <= N) return true;
  }
  return false;
}

function creditsRefilled(acc) {
  if (!acc || !acc.limit || acc.limit.kind !== 'credits') return false;
  
  const raw = acc.limit.creditsAt;
  if (raw === null || raw === undefined || typeof raw !== 'number' || !Number.isFinite(raw)) return false;
  const base = raw;
  const q = acc.quota || {};
  const now = (typeof q.monthlyRemaining === 'number' && Number.isFinite(q.monthlyRemaining))
    ? q.monthlyRemaining
    : ((q.credits && typeof q.credits.monthlyCredits === 'number') ? q.credits.monthlyCredits : NaN);
  return Number.isFinite(now) && now > base;
}

module.exports = { classifyUpstreamLimited, headerRetryMs, bodyResetMs, normalizeResetTs, fmtClock, isQuotaCreditsLow, quotaOverallStatus, monthlyResetAtOf, accountQuotaSummary, windowExhausted, nextResetAt, creditsResetDue, creditsRefilled };
