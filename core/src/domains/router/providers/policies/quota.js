'use strict';

// 额度判定 + 响应分类：纯函数，零 IO / 零 require，覆盖窗口/credits 谓词、重置时间归一、
// 上游限制词表分类与配额总览。供应商可覆写 provider.classifyResponse 使用专属错误码，本文件只提供默认实现。

/** 上游「限额/封禁」默认词表：只表达「这类词属于时间窗额度 / 属于预付余额」。
 *  识别不了 = 宁可不切，也不误判（供应商可覆写 classifyResponse 用专属语义）。 */
const QUOTA_KEYWORDS = ['insufficient_quota','quota_exceeded','quota reached','usage limit','5-hour usage limit','5 hour usage limit','monthly limit','weekly limit','gousagelimiterror','out of quota','quota has been exceeded'];
const CREDIT_KEYWORDS = ['insufficient credit','insufficient credits','insufficient balance','credit balance','no credits','out of credit','purchase credits','purchase more credits','add credits','billing error','balance'];

/** 默认上游限制分类（纯函数；返回 signal 字符串）：
 *  credits=预付余额不足（充值恢复）| window=时间窗配额（resetsAt 恢复）| banned=账号被封（401/403 无配额信息）
 *  | transient=平台瞬时（503/502 等，不冻结）| none=语义错误/不可判（透传，不切换）。 */
function classifyUpstreamLimited(status, text) {
  const lower = String(text || '').toLowerCase();
  const has = (kws) => kws.some((kw) => lower.includes(kw));
  if (status === 402 || has(CREDIT_KEYWORDS)) return 'credits';
  if (has(QUOTA_KEYWORDS)) return 'window';
  if (status >= 500 && status <= 599) return 'transient';
  if (status === 401 || status === 403) return 'banned';
  return 'none';
}

/** Retry-After / x-ratelimit-reset-ms 头 -> 冻结时长（ms）。 */
function headerRetryMs(headers) {
  const h = headers || {};
  const epMs = h['x-ratelimit-reset-ms'];
  if (epMs !== undefined && String(epMs).trim() !== '') {
    const n = parseInt(String(epMs), 10);
    if (Number.isFinite(n) && n > 0) return Math.max(0, n - Date.now());
  }
  const raw = String(h['retry-after'] || '').trim();
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  // HTTP-date 绝对时刻（RFC 7231）
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : 0;
}

/** 响应体中的 “resets in N min/sec” / “resets at <ISO>” 转为冻结时长（ms）。 */
function bodyResetMs(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const m = /(?:resets?|retry|try again|after|available)\s+in\s+(\d+)\s*(min|sec|second|s|hour|hr)?/.exec(lower);
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) {
      const unit = m[2] || '';
      return unit.startsWith('min') ? n * 60000
        : (unit.startsWith('hour') || unit.startsWith('hr')) ? n * 3600000
        : n * 1000;
    }
  }
  const iso = /(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/.exec(t);
  if (iso) {
    const at = normalizeResetTs(iso[1]);
    if (at && at > Date.now()) return at - Date.now();
    if (at && at <= Date.now()) return 0;
  }
  return 0;
}

/** 归一化窗口重置时间为 epoch 毫秒（或 null）：兼容 ISO 字符串、epoch 毫秒/秒数字、数字字符串；
 *  epoch 秒/毫秒以 < 1e12 判秒消歧。 */
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

/** 本地时钟文本（YYYY-MM-DD HH:mm）：冻结原因/证据中的可读时间。 */
function fmtClock(ms) {
  try {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } catch { return ''; }
}

/** credits 受限判定（单源纯函数）：月度池=0 / 低余额提醒 / 汇总<=0 即受限。 */
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

/** 统一配额总览标签（展示/视图单源）：credits 受限优先；月窗口满，或 5h 与周同时满即用尽。 */
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

/** 账号「月度额度重置」精确时刻（quota.monthlyResetAt，epoch ms）：仅当存在且在未来时返回，否则 0。 */
function monthlyResetAtOf(acc) {
  const q = (acc && acc.quota) || {};
  const v = Number(q && q.monthlyResetAt);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v > Date.now() ? v : 0;
}

/** 账号配额摘要（展示形状）。 */
function accountQuotaSummary(acc) {
  const q = (acc && acc.quota) || {};
  const win = (w) => (w ? { percent: w.percent ?? null, status: w.status || null, resetsAt: w.resetsAt || null } : null);
  return { rolling: win(q.rolling), weekly: win(q.weekly), monthly: win(q.monthly), overall: q.overallStatus || null };
}

/** 单个窗口是否已满。 */
function windowFull(w) {
  return !!w && (w.status === 'rate-limited' || (Number.isFinite(Number(w.percent)) && Number(w.percent) >= 100));
}

/** 唯一「时间窗额度用尽」判定：挑号/状态机/定时探测共用。 */
function windowExhausted(acc) {
  const sum = accountQuotaSummary(acc);
  return [sum.rolling, sum.weekly, sum.monthly].some((w) => w && (w.status === 'rate-limited' || (w.percent !== null && w.percent >= 100)));
}

/** 各窗口最近恢复时间（精确优先；无精确 resetsAt 时按窗口类型兜底）。
 *  @returns {t:number|null, precise:boolean} precise=true 表示来自真实 resetsAt。 */
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

/** credits 冻结的正向恢复证据 a)：月度重置到期。 */
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

/** credits 冻结的正向恢复证据 b)：余额较冻结时刻回升（充值场景）。 */
function creditsRefilled(acc) {
  if (!acc || !acc.limit || acc.limit.kind !== 'credits') return false;
  // 基线缺失必须显式判空。Number(null)===0 是有限值，
  //   冻结时以 null 记录基线（freeze.js 无余额证据分支）会让任意正余额被判「已充值」，
  //   耗尽账号被重新选路 —— fail-closed：无基线只认证据 a)。
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
