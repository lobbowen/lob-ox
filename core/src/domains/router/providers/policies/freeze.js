'use strict';

const quota = require('./quota');

const CREDITS_RECHECK_MS = 10 * 60 * 1000;

function setStatus(acc, status, nextResetAt, error, autoRecover, provider) {
  const prev = acc.status;
  acc.status = status;
  if (nextResetAt !== undefined) acc.nextResetAt = nextResetAt;
  if (error !== undefined) acc.lastProbeError = error;
  if ((status === 'frozen' || status === 'banned') && provider.activeAccount && provider.activeAccount.keyId === acc.keyId) {
    provider.markNotInUse(acc.keyId);
  }
  if ((status === 'frozen' || status === 'banned' || status === 'discarded') && provider.selectedAccountKeyId === acc.keyId) {
    provider.selectedAccountKeyId = null;
  }
  provider._persist();
  if (prev === status) return;
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

function setLimit(acc, kind, reason, recovery, provider) {
  if (!acc) return null;
  const prevAt = (acc.limit && acc.limit.kind === kind && typeof acc.limit.creditsAt === 'number') ? acc.limit.creditsAt : undefined;
  acc.limit = { kind, since: acc.limit && acc.limit.kind === kind ? acc.limit.since : Date.now(), reason: reason || null, recovery: recovery || null };
  if (prevAt !== undefined) acc.limit.creditsAt = prevAt;
  provider._persist();
  return acc.limit;
}

function freezeLimited(acc, cause, reason, recovery, provider) {
  if (!acc || acc.status === 'banned' || acc.status === 'discarded') return false;
  const rec = recovery || { type: 'poll', periodMs: CREDITS_RECHECK_MS };
  const at = rec.type === 'at' && rec.at ? rec.at : 0;
  const next = at || Date.now() + (rec.periodMs || CREDITS_RECHECK_MS);
  acc.detectError = reason;
  if (acc.status !== 'frozen') setStatus(acc, 'frozen', next, reason, false, provider);
  else { acc.nextResetAt = next; provider._persist(); }
  const lim = setLimit(acc, cause, reason, rec, provider);
  if (cause === 'credits' && lim) {
    const q = acc.quota || {};
    lim.creditsAt = (typeof q.monthlyRemaining === 'number' && Number.isFinite(q.monthlyRemaining))
      ? q.monthlyRemaining
      : ((q.credits && typeof q.credits.monthlyCredits === 'number') ? q.credits.monthlyCredits : null);
  }
  if (provider.events) provider.events.append('account_frozen', { provider: provider.name, key: acc.maskedKey, until: at || next, kind: cause });
  return true;
}

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

function markBanned(acc, error, provider) {
  setStatus(acc, 'banned', null, error || '账号被禁用', false, provider);
  setLimit(acc, 'banned', error || '账号被封禁', { type: 'manual' }, provider);
  if (provider.events) provider.events.append('account_banned', { provider: provider.name, key: acc.maskedKey, kind: 'banned' });
}

function applyDetection(acc, det, provider) {
  acc.lastProbeAt = Date.now();
  if (!det || !det.ok) {
    if (det && det.banned) {
      setStatus(acc, 'banned', null, det.error || '账号被禁用', false, provider);
    } else {
      acc.lastProbeError = (det && det.error) || '状态检测失败';
      if (acc.status === 'frozen' && !acc.nextResetAt) {
        acc.nextResetAt = Date.now() + CREDITS_RECHECK_MS;
      }
      provider._persist();
    }
    return;
  }
  acc.lastProbeError = null;
  if (det.quota) acc.quota = det.quota;
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
    const nr = provider._nextResetAt(acc.quota);
    const precise = nr.precise && nr.t;
    const staleExisting = acc.nextResetAt && acc.nextResetAt <= Date.now();
    if (precise && (!acc.nextResetAt || staleExisting || nr.t < acc.nextResetAt)) acc.nextResetAt = nr.t;
    else if (!precise && (!acc.nextResetAt || staleExisting)) acc.nextResetAt = nr.t;
    freezeLimited(acc, 'window', '额度用尽', { type: 'at', at: acc.nextResetAt || null }, provider);
  } else {
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
