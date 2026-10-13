'use strict';

const quota = require('./quota');

const CREDITS_RECHECK_MS = 10 * 60 * 1000;

// R5/D.7-P1-13、D.9-1、D.5-P1-14：账号状态机的单一出口。
//
// 原缺陷：acc.status 与 acc.limit 有六个写入点（setStatus / freezeLimited / setLimit /
// normalizeConsistency / applyDetection / deserializeProvider），每个实现的副作用集合
// 都不同。normalizeConsistency 裸赋值跳过 setStatus 的三个副作用（markNotInUse、
// selectedAccountKeyId 清理、_onStatusTransition），而它在 serializeProvider 里被
// 调用——每次 save 都对每账号跑一遍，于是 reclaimAccount 不触发、实例不停、
// 端口不释放成为常态。setLimit 的 creditsAt 保留要求 kind 相同，credits 与 window
// 双耗尽时 kind 被覆盖，余额恢复判据永久丢失。
//
// 修法：状态变更只能通过 transition()。它从 next 描述推导全部副作用（穷举且
// 幂等），调用方只负责回答「下一个状态应该是什么」，不负责分别执行副作用。

// 从「探测结果 + 当前状态」纯函数推导下一个状态。
// 返回 null 表示无需变更。 banned 只接受显式的人工恢复意图（manual），
// 探测成功不产生该意图——这是 D.5-P1-14（banned 被探测自动解封）的修法。
function deriveNext(acc, det, provider) {
  if (!det || !det.ok) {
    if (det && det.banned) return { status: 'banned', limit: { kind: 'banned', reason: det.error || '账号被封禁', recovery: { type: 'manual' } }, reason: det.error || '账号被禁用' };
    return null; // 探测失败不改状态，只记 lastProbeError
  }
  if (acc.status === 'banned' || acc.status === 'discarded') return null;
  if (provider._isCreditsLow(acc)) {
    const monthlyAt = quota.monthlyResetAtOf(acc);
    const prevAt = (acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery && acc.limit.recovery.type === 'at' && acc.limit.recovery.at && acc.limit.recovery.at > Date.now()) ? acc.limit.recovery.at : 0;
    const effectiveAt = monthlyAt || prevAt;
    return {
      status: 'frozen',
      limit: { kind: 'credits', reason: effectiveAt ? '额度用尽（原因：月额度，预计 ' + quota.fmtClock(effectiveAt) + ' 自动恢复）' : '额度用尽（原因：月额度，待月度重置后自动恢复）', recovery: effectiveAt ? { type: 'at', at: effectiveAt } : { type: 'poll', periodMs: CREDITS_RECHECK_MS } },
      nextResetAt: effectiveAt || Date.now() + CREDITS_RECHECK_MS,
      creditsAt: creditsValueOf(acc),
    };
  }
  if (provider._windowExhausted(acc)) {
    const nr = provider._nextResetAt(acc.quota);
    const precise = nr.precise && nr.t;
    const staleExisting = acc.nextResetAt && acc.nextResetAt <= Date.now();
    let at = acc.nextResetAt;
    if (precise && (!acc.nextResetAt || staleExisting || nr.t < acc.nextResetAt)) at = nr.t;
    else if (!precise && (!acc.nextResetAt || staleExisting)) at = nr.t;
    return { status: 'frozen', limit: { kind: 'window', reason: '额度用尽', recovery: { type: 'at', at: at || null } }, nextResetAt: at || Date.now() + CREDITS_RECHECK_MS };
  }
  // 额度正常：恢复 ready。credits 冻结的要等 resetDue 或 refilled 之一成立。
  if (acc.status === 'frozen' && acc.limit && acc.limit.kind === 'credits') {
    const resetDue = quota.creditsResetDue(acc);
    const refilled = quota.creditsRefilled(acc);
    if (!resetDue && !refilled) {
      const monthlyAt = quota.monthlyResetAtOf(acc);
      const at = acc.nextResetAt || monthlyAt || 0;
      return {
        status: 'frozen',
        limit: { kind: 'credits', reason: at ? '额度用尽（原因：月额度，预计 ' + quota.fmtClock(at) + ' 自动恢复）' : '额度用尽（原因：月额度，待月度重置后自动恢复）', recovery: at ? { type: 'at', at } : { type: 'poll', periodMs: CREDITS_RECHECK_MS } },
        nextResetAt: at || Date.now() + CREDITS_RECHECK_MS,
      };
    }
  }
  if (acc.status === 'frozen' || acc.status === 'banned' || acc.status !== 'ready') {
    return { status: 'ready', limit: null, nextResetAt: null, autoRecover: acc.status === 'frozen' || acc.status === 'banned' };
  }
  return null;
}

function creditsValueOf(acc) {
  const q = acc.quota || {};
  if (typeof q.monthlyRemaining === 'number' && Number.isFinite(q.monthlyRemaining)) return q.monthlyRemaining;
  if (q.credits && typeof q.credits.monthlyCredits === 'number') return q.credits.monthlyCredits;
  return null;
}

// 唯一允许改 acc.status 与 acc.limit 的地方。
// 副作用穷举：activeAccount、selectedAccountKeyId、nextResetAt、lastProbeError、
// 实例回收（经 _onStatusTransition）、事件、持久化。
// 幂等：next 与当前状态一致时只做必要的字段补齐，不重复触发事件与回收。
function transition(acc, next, provider, opts) {
  if (!acc || !next || !next.status) return { changed: false };
  const o = opts || {};
  const prev = acc.status;
  const prevLimitKind = acc.limit && acc.limit.kind;
  const effects = [];

  acc.status = next.status;
  if (next.nextResetAt !== undefined) acc.nextResetAt = next.nextResetAt;
  if (next.reason !== undefined && next.reason !== null) acc.lastProbeError = next.reason;

  // limit 整体替换。creditsAt 的保留策略在此统一处理（不再分散在 setLimit 的
  // kind 相等条件里）——D.9-1 的修法。
  if (next.limit === null) {
    acc.limit = null;
  } else if (next.limit) {
    const keepSince = (prevLimitKind === next.limit.kind && acc.limit && acc.limit.since) ? acc.limit.since : Date.now();
    // creditsAt 跨 kind 保留：余额基准与 limit 属于哪个种类无关。原实现要求
    // kind 相同才保留，双耗尽时 kind 被覆盖即丢失（D.9-1）。
    const keepCreditsAt = (typeof next.limit.creditsAt === 'number') ? next.limit.creditsAt
      : ((acc.limit && typeof acc.limit.creditsAt === 'number') ? acc.limit.creditsAt : undefined);
    acc.limit = Object.assign({ kind: next.limit.kind, since: keepSince, reason: next.limit.reason || null, recovery: next.limit.recovery || null }, keepCreditsAt !== undefined ? { creditsAt: keepCreditsAt } : {});
  }

  // 副作用穷举（顺序固定，保证可推断）
  if ((next.status === 'frozen' || next.status === 'banned') && provider.activeAccount && provider.activeAccount.keyId === acc.keyId) {
    provider.markNotInUse(acc.keyId);
    effects.push('markNotInUse');
  }
  if ((next.status === 'frozen' || next.status === 'banned' || next.status === 'discarded') && provider.selectedAccountKeyId === acc.keyId) {
    provider.selectedAccountKeyId = null;
    effects.push('clearSelected');
  }

  provider._persist();

  if (prev !== next.status) {
    if (typeof provider._onStatusTransition === 'function') {
      provider._onStatusTransition(acc, prev, next.status);
      effects.push('onStatusTransition');
    }
    if (provider.events) {
      const autoRecover = next.autoRecover === true;
      provider.events.append(autoRecover ? 'account_recovered' : 'account_status', { provider: provider.name, key: acc.maskedKey, from: prev, to: next.status });
      effects.push('event');
    }
    if (provider.logger && provider.logger.info) provider.logger.info('account ' + acc.maskedKey + ': ' + prev + ' → ' + next.status);
  }
  return { changed: prev !== next.status || prevLimitKind !== (acc.limit && acc.limit.kind), effects, from: prev, to: next.status };
}

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

// M6：从「当前状态 + 上次探测错误」纯推导 limit 描述，不读 acc.limit、不写回。
// 无可推导的 limit（ready 等状态）时返回 null。
function deriveLimit(acc) {
  const st = acc.status;
  let kind = null, recovery = null, reason = null;
  if (st === 'banned') { kind = 'banned'; recovery = { type: 'manual' }; reason = acc.detectError || acc.lastProbeError || '账号被封禁'; }
  else if (st === 'frozen') {
    const err = String(acc.detectError || acc.lastProbeError || '').toLowerCase();
    if (err.includes('credits') || err.includes('余额不足')) { kind = 'credits'; recovery = { type: 'poll', periodMs: CREDITS_RECHECK_MS }; reason = 'credits 余额不足（充值后自动恢复）'; }
    else { kind = 'window'; recovery = { type: 'at', at: acc.nextResetAt || null }; reason = '时间窗额度用尽'; }
  }
  if (!kind) return null;
  return { kind, since: Date.now(), reason, recovery };
}

function ensureLimit(acc) {
  if (!acc) return null;
  if (acc.limit && acc.limit.kind) return acc.limit;
  acc.limit = deriveLimit(acc) || acc.limit;
  return acc.limit;
}

function previewLimit(acc) {
  if (!acc) return null;
  if (acc.limit && acc.limit.kind) return acc.limit;
  return deriveLimit(acc) || acc.limit;
}

// R5/D.9-1：原 creditsAt 保留要求「传入 kind 与现有 limit.kind 相同」，
// 于是 credits 与 window 双耗尽时 kind 被覆盖为 window，creditsAt 永久丢失，
// creditsRefilled 的余额恢复判据再也构不上。现改为跨 kind 保留——余额基准与
// limit 是哪个种类无关。
// 注意：新代码应优先走 transition()；本函数保留给 freezeLimited 等尚未迁移的
// 内部路径，且已修正保留策略。
function setLimit(acc, kind, reason, recovery, provider) {
  if (!acc) return null;
  const prevAt = (acc.limit && typeof acc.limit.creditsAt === 'number') ? acc.limit.creditsAt : undefined;
  const keepSince = (acc.limit && acc.limit.kind === kind && acc.limit.since) ? acc.limit.since : Date.now();
  acc.limit = { kind, since: keepSince, reason: reason || null, recovery: recovery || null };
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

// R5/D.5-P1-14：原实现在「额度正常」分支里 prev === 'banned' 也走
// setStatus(acc, 'ready', ...)，于是 401/403 封禁的账号只要之后一次配额探测成功
// 就无声恢复 ready 重新参与选号，markBanned 显式设置的 manual recovery 形同虚设。
// 现 banned 的恢复只接受显式人工意图（discardAccount 或 o.manual），探测成功
// 不产生该意图——deriveNext 对 banned 直接返回 null。
function applyDetection(acc, det, provider) {
  acc.lastProbeAt = Date.now();
  if (!det || !det.ok) {
    const next = deriveNext(acc, det, provider);
    if (next) { transition(acc, next, provider); return; }
    acc.lastProbeError = (det && det.error) || '状态检测失败';
    if (acc.status === 'frozen' && !acc.nextResetAt) {
      acc.nextResetAt = Date.now() + CREDITS_RECHECK_MS;
    }
    provider._persist();
    return;
  }
  acc.lastProbeError = null;
  if (det.quota) acc.quota = det.quota;
  const next = deriveNext(acc, det, provider);
  if (next) transition(acc, next, provider);
  else provider._persist();
}

// R5/D.7-P1-13：原实现裸赋值 acc.status = 'frozen'，跳过 setStatus 的三个副作用
// （markNotInUse、selectedAccountKeyId 清理、_onStatusTransition）。而本函数在
// serializeProvider 里被调用（providers/model.js），即每次 save 都对每账号跑一遍，
// 于是 reclaimAccount 不触发、实例不停、端口不释放成为常态。
// 现改为走 transition——副作用由单一出口穷举保证。
function normalizeConsistency(acc, provider) {
  if (!acc) return;
  if (acc.status !== 'ready') return;
  const q = acc.quota;
  if (!q || typeof q !== 'object') return;
  const full = provider._windowExhausted(acc) || provider._isCreditsLow(acc);
  if (!full) return;
  const cause = provider._isCreditsLow(acc) ? 'credits' : 'window';
  const nr = provider._nextResetAt ? provider._nextResetAt(q) : null;
  if (provider.logger && provider.logger.warn) provider.logger.warn('consistency guard: ready 账号额度已满（' + cause + '）→ 归位 frozen key=' + (acc.maskedKey || acc.keyId));
  const at = (acc.nextResetAt && acc.nextResetAt > Date.now()) ? acc.nextResetAt : ((nr && nr.t) || 0);
  transition(acc, {
    status: 'frozen',
    limit: acc.limit && acc.limit.kind
      ? null // 已有 limit：只补 nextResetAt，不动 limit（transition 对 null 的含义是清空，
             // 故此处用「保持」语义：下面单独处理）
      : { kind: cause, reason: acc.detectError || '额度用尽（一致性归位）', recovery: at ? { type: 'at', at } : { type: 'poll', periodMs: CREDITS_RECHECK_MS } },
    nextResetAt: at || Date.now() + CREDITS_RECHECK_MS,
    reason: acc.detectError || '额度用尽（一致性归位）',
  }, provider);
  // 已有 limit 时 transition 的 limit:null 会清空它——这与原实现「保留已有 limit」
  // 的语义相反，故此处补回。保留比清空更安全：limit 携带恢复判据。
  if (!acc.limit) {
    acc.limit = { kind: cause, since: Date.now(), reason: acc.detectError || '额度用尽（一致性归位）', recovery: at ? { type: 'at', at } : { type: 'poll', periodMs: CREDITS_RECHECK_MS } };
  }
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

module.exports = {
  // R5 新增：单一出口与纯推导。新代码只应使用这两个加 markBanned / discardAccount。
  transition, deriveNext, creditsValueOf,
  // 以下为尚未迁移完的内部路径保留，迁移完成后删除。
  setStatus, ensureLimit, previewLimit, setLimit, freezeLimited,
  markCreditsExhausted, markQuotaExhausted, markBanned,
  applyDetection, normalizeConsistency, reconcileLock,
};
