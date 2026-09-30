'use strict';

// 冻结/恢复策略：状态迁移纯计算，事件/持久化全部经显式入参 provider 执行（保留其方法覆写语义）。
// 本文件 require 零 IO。

const quota = require('./quota');

/** credits 余额不足的重探周期（ms）：预付余额无自然恢复时刻——冻结后按此周期回探。 */
const CREDITS_RECHECK_MS = 10 * 60 * 1000;

function setStatus(acc, status, nextResetAt, error, autoRecover, provider) {
  const prev = acc.status;
  acc.status = status;
  if (nextResetAt !== undefined) acc.nextResetAt = nextResetAt;
  if (error !== undefined) acc.lastProbeError = error;
  // 状态真实化：杜绝「frozen 且在用」矛盾
  if ((status === 'frozen' || status === 'banned') && provider.activeAccount && provider.activeAccount.keyId === acc.keyId) {
    provider.markNotInUse(acc.keyId);
  }
  if ((status === 'frozen' || status === 'banned' || status === 'discarded') && provider.selectedAccountKeyId === acc.keyId) {
    provider.selectedAccountKeyId = null;
  }
  provider._persist();
  if (prev === status) return;
  // 迁移的进程副作用经 provider._onStatusTransition 由能力方 mixin（process-pool）执行；本文件零 IO。
  if (typeof provider._onStatusTransition === 'function') provider._onStatusTransition(acc, prev, status);
  if (provider.events) {
    if (autoRecover) {
      provider.events.append('account_recovered', { provider: provider.name, key: acc.maskedKey, from: prev, to: status });
    } else {
      provider.events.append('account_status', { provider: provider.name, key: acc.maskedKey, from: prev, to: status });
    }
  }
  if (provider.logger && provider.logger.info) provider.logger.info('account ' + acc.maskedKey + ': ' + prev + ' → ' + status);
}

/** limit：把「为什么受限 / 何时恢复」固化为账号一等字段。 */
function ensureLimit(acc) {
  if (!acc) return null;
  if (acc.limit && acc.limit.kind) return acc.limit;
  const st = acc.status;
  let kind = null, recovery = null, reason = null;
  if (st === 'banned') { kind = 'banned'; recovery = { type: 'manual' }; reason = acc.detectError || acc.lastProbeError || '账号被封禁'; }
  else if (st === 'frozen') {
    const err = String(acc.detectError || acc.lastProbeError || '').toLowerCase();
    if (err.includes('credits') || err.includes('余额不足')) { kind = 'credits'; recovery = { type: 'poll', periodMs: CREDITS_RECHECK_MS }; reason = 'credits 余额不足（充值后自动恢复）'; }
    else { kind = 'window'; recovery = { type: 'at', at: acc.nextResetAt || null }; reason = '时间窗额度用尽'; }
  }
  if (kind) acc.limit = { kind, since: Date.now(), reason, recovery };
  return acc.limit;
}

/** limit 纯只读预览：与 ensureLimit 同逻辑同形状，但不赋值、不写盘——只读视图（views.listProviders）唯一入口，视图内禁写副作用。 */
function previewLimit(acc) {
  if (!acc) return null;
  if (acc.limit && acc.limit.kind) return acc.limit;
  const st = acc.status;
  let kind = null, recovery = null, reason = null;
  if (st === 'banned') { kind = 'banned'; recovery = { type: 'manual' }; reason = acc.detectError || acc.lastProbeError || '账号被封禁'; }
  else if (st === 'frozen') {
    const err = String(acc.detectError || acc.lastProbeError || '').toLowerCase();
    if (err.includes('credits') || err.includes('余额不足')) { kind = 'credits'; recovery = { type: 'poll', periodMs: CREDITS_RECHECK_MS }; reason = 'credits 余额不足（充值后自动恢复）'; }
    else { kind = 'window'; recovery = { type: 'at', at: acc.nextResetAt || null }; reason = '时间窗额度用尽'; }
  }
  if (kind) return { kind, since: Date.now(), reason, recovery };
  return acc.limit;
}

/** 写 limit（保留同 kind 的证据基线 creditsAt）。 */
function setLimit(acc, kind, reason, recovery, provider) {
  if (!acc) return null;
  const prevAt = (acc.limit && acc.limit.kind === kind && typeof acc.limit.creditsAt === 'number') ? acc.limit.creditsAt : undefined;
  acc.limit = { kind, since: acc.limit && acc.limit.kind === kind ? acc.limit.since : Date.now(), reason: reason || null, recovery: recovery || null };
  if (prevAt !== undefined) acc.limit.creditsAt = prevAt;
  provider._persist();
  return acc.limit;
}

/** 统一受限冻结（credits/window 同一套状态机：置 frozen + 记恢复点 + 设 limit + 事件）。
 *  @param recovery {type:'at'|'poll', at?|periodMs?} at 优先作为 nextResetAt，poll 用 now+periodMs */
function freezeLimited(acc, cause, reason, recovery, provider) {
  if (!acc || acc.status === 'banned' || acc.status === 'discarded') return false;
  const rec = recovery || { type: 'poll', periodMs: CREDITS_RECHECK_MS };
  const at = rec.type === 'at' && rec.at ? rec.at : 0;
  const next = at || Date.now() + (rec.periodMs || CREDITS_RECHECK_MS);
  acc.detectError = reason;
  if (acc.status !== 'frozen') setStatus(acc, 'frozen', next, reason, false, provider);
  else { acc.nextResetAt = next; provider._persist(); }
  const lim = setLimit(acc, cause, reason, rec, provider);
  // credits 冻结记录冻结时刻的月余额基线：解冻只认正向证据（periodEnd 到期或余额回升）
  if (cause === 'credits' && lim) {
    const q = acc.quota || {};
    lim.creditsAt = (typeof q.monthlyRemaining === 'number' && Number.isFinite(q.monthlyRemaining))
      ? q.monthlyRemaining
      : ((q.credits && typeof q.credits.monthlyCredits === 'number') ? q.credits.monthlyCredits : null);
  }
  if (provider.events) provider.events.append('account_frozen', { provider: provider.name, key: acc.maskedKey, until: at || next, kind: cause });
  return true;
}

/** credits 额度用尽标记（上游 400/402/429/403 报错驱动）：无自然到点恢复 -> recovery.at 或周期重探。 */
function markCreditsExhausted(acc, provider) {
  if (!acc || acc.status === 'banned' || acc.status === 'discarded') return;
  const monthlyAt = quota.monthlyResetAtOf(acc);
  const recovery = monthlyAt
    ? { type: 'at', at: monthlyAt }
    : { type: 'poll', periodMs: CREDITS_RECHECK_MS };
  const reason = monthlyAt
    ? '额度用尽（原因：月额度，预计 ' + quota.fmtClock(monthlyAt) + ' 自动恢复）'
    : '额度用尽（原因：月额度，待月度重置后自动恢复）';
  freezeLimited(acc, 'credits', reason, recovery, provider);
}

/** 429/403 配额响应：第一时间冻结账号（精确到恢复时间）。 */
function markQuotaExhausted(acc, cooldownMs, provider) {
  let cooldown = cooldownMs > 0 ? cooldownMs : 0;
  if (!(cooldown > 0)) {
    const q = (acc && acc.quota) || {};
    const now = Date.now();
    let soonest = null;
    for (const w of [q.rolling, q.weekly, q.monthly]) {
      if (!w) continue;
      const at = quota.normalizeResetTs(w.resetsAt);
      if (at && at > now && (soonest === null || at < soonest)) soonest = at;
    }
    if (soonest !== null) cooldown = soonest - now;
  }
  const capped = cooldown > 0 ? Math.min(cooldown, 30 * 24 * 3600 * 1000) : 5 * 3600 * 1000;
  const until = Date.now() + capped;
  freezeLimited(acc, 'window', '额度用尽', { type: 'at', at: until }, provider);
}

/** 封号（401 / 403 非配额性拒绝，或检测到账号禁用）。 */
function markBanned(acc, error, provider) {
  setStatus(acc, 'banned', null, error || '账号被禁用', false, provider);
  setLimit(acc, 'banned', error || '账号被封禁', { type: 'manual' }, provider);
  if (provider.events) provider.events.append('account_banned', { provider: provider.name, key: acc.maskedKey, kind: 'banned' });
}

/** 应用一次状态检测结果（定时轮询 / 配额刷新共用）：恢复自动解冻，仍限额保持，报错反馈。 */
function applyDetection(acc, det, provider) {
  acc.lastProbeAt = Date.now();
  if (!det || !det.ok) {
    if (det && det.banned) {
      setStatus(acc, 'banned', null, det.error || '账号被禁用', false, provider);
    } else {
      acc.lastProbeError = (det && det.error) || '状态检测失败';
      // 探测失败也必须给一个重探时刻，否则 frozen+探测失败会每 5min 启停风暴。
      if (acc.status === 'frozen' && !acc.nextResetAt) {
        acc.nextResetAt = Date.now() + CREDITS_RECHECK_MS;
      }
      provider._persist();
    }
    return;
  }
  acc.lastProbeError = null;
  if (det.quota) acc.quota = det.quota;
  // credits 预付余额不足：检测到即保持冻结，按 recovery 节奏重探（充值/重置后恢复）。
  if (acc.status !== 'banned' && acc.status !== 'discarded' && provider._isCreditsLow(acc)) {
    const monthlyAt = quota.monthlyResetAtOf(acc);
    const prevAt = (acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery && acc.limit.recovery.type === 'at' && acc.limit.recovery.at && acc.limit.recovery.at > Date.now()) ? acc.limit.recovery.at : 0;
    const effectiveAt = monthlyAt || prevAt;
    const recovery = effectiveAt
      ? { type: 'at', at: effectiveAt }
      : { type: 'poll', periodMs: CREDITS_RECHECK_MS };
    const reason = effectiveAt
      ? '额度用尽（原因：月额度，预计 ' + quota.fmtClock(effectiveAt) + ' 自动恢复）'
      : '额度用尽（原因：月额度，待月度重置后自动恢复）';
    freezeLimited(acc, 'credits', reason, recovery, provider);
    return;
  }
  if (provider._windowExhausted(acc)) {
    // 仍限额：保持冻结，nextResetAt 按下述规则精确更新
    const nr = provider._nextResetAt(acc.quota);
    // 防回推：纯兜底不得覆写已精确值；精确值仅在更早时收敛；过期值无条件采纳新精确值。
    const precise = nr.precise && nr.t;
    const staleExisting = acc.nextResetAt && acc.nextResetAt <= Date.now();
    if (precise && (!acc.nextResetAt || staleExisting || nr.t < acc.nextResetAt)) acc.nextResetAt = nr.t;
    else if (!precise && (!acc.nextResetAt || staleExisting)) acc.nextResetAt = nr.t;
    freezeLimited(acc, 'window', '额度用尽', { type: 'at', at: acc.nextResetAt || null }, provider);
  } else {
    // credits 冻结的解冻门槛：只认正向恢复证据（a 重置到期 / b 余额回升）；无证据维持冻结。
    const prev = acc.status;
    if (prev === 'frozen' && acc.limit && acc.limit.kind === 'credits') {
      const resetDue = quota.creditsResetDue(acc);
      const refilled = quota.creditsRefilled(acc);
      if (!resetDue && !refilled) {
        const monthlyAt = quota.monthlyResetAtOf(acc);
        const at = acc.nextResetAt || monthlyAt || 0;
        const reason = at
          ? '额度用尽（原因：月额度，预计 ' + quota.fmtClock(at) + ' 自动恢复）'
          : '额度用尽（原因：月额度，待月度重置后自动恢复）';
        const recovery = at ? { type: 'at', at } : { type: 'poll', periodMs: CREDITS_RECHECK_MS };
        // 维持分支必须补 nextResetAt，否则下拍探测时刻缺失（frozen+无时刻 -> 每 5min 探测风暴）。
        // at 已有精确值时保持原值（不覆写已精确语义）；at=0 时以重探周期兜底。
        acc.nextResetAt = at || Date.now() + CREDITS_RECHECK_MS;
        setLimit(acc, 'credits', reason, recovery, provider);
        acc.detectError = reason;
        provider._persist();
        return;
      }
    }
    acc.nextResetAt = null;
    acc.limit = null;
    if (prev === 'frozen' || prev === 'banned') {
      setStatus(acc, 'ready', null, null, true, provider);
    } else if (acc.status !== 'ready') {
      setStatus(acc, 'ready', null, null, false, provider);
    } else {
      provider._persist();
    }
  }
}

/** 一致性守卫（serialize 前置）：ready 账号已知额度已满时写盘前归位 frozen + limit（纯字段修正，不递归写盘）。 */
function normalizeConsistency(acc, provider) {
  if (!acc) return;
  const st = acc.status;
  if (st !== 'ready') return;
  const q = acc.quota;
  if (!q || typeof q !== 'object') return;
  const full = provider._windowExhausted(acc) || provider._isCreditsLow(acc);
  if (!full) return;
  const cause = provider._isCreditsLow(acc) ? 'credits' : 'window';
  const nr = provider._nextResetAt ? provider._nextResetAt(q) : null;
  if (provider.logger && provider.logger.warn) provider.logger.warn('consistency guard: ready 账号额度已满（' + cause + '）→ 归位 frozen key=' + (acc.maskedKey || acc.keyId));
  acc.status = 'frozen';
  if (acc.limit && acc.limit.kind) {
    if (!acc.nextResetAt && nr && nr.t) acc.nextResetAt = nr.t;
  } else {
    const at = (acc.nextResetAt && acc.nextResetAt > Date.now()) ? acc.nextResetAt : ((nr && nr.t) || 0);
    acc.limit = { kind: cause, since: Date.now(), reason: acc.detectError || '额度用尽（一致性归位）', recovery: at ? { type: 'at', at } : { type: 'poll', periodMs: CREDITS_RECHECK_MS } };
    if (at) acc.nextResetAt = at;
    else if (!acc.nextResetAt) acc.nextResetAt = Date.now() + CREDITS_RECHECK_MS;
  }
  if (provider.activeAccount && provider.activeAccount.keyId === acc.keyId) provider.activeAccount = null;
}

/** 锁收敛：锁只对「当前可用」账号有意义；离开可用池即锁失效。 */
function reconcileLock(provider) {
  const lockedId = provider.selectedAccountKeyId || null;
  if (!lockedId) return;
  const acc = (provider.accounts || []).find((a) => a.keyId === lockedId);
  const usable = !!acc && acc.status === 'ready' && (typeof provider.isAccountUsable !== 'function' || provider.isAccountUsable(acc));
  if (!usable) {
    provider.selectedAccountKeyId = null;
  }
}

module.exports = { setStatus, ensureLimit, previewLimit, setLimit, freezeLimited, markCreditsExhausted, markQuotaExhausted, markBanned, applyDetection, normalizeConsistency, reconcileLock };
