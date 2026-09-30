'use strict';

// S1 选号纯策略：零 require / 零 this / 零 IO；可用性与就绪由调用方算好 bool 传入。
// 契约：绝不跨供应商 failover —— 只在传入的单个 state 池内选。

/** 在单个供应商的账号池内选号。
 *  state = { accounts:[{key,keyId,maskedKey,status,usable,running}], selectedAccountKeyId, activeAccountKeyId, cursor, instancePool }；
 *  opts.excludeKeys = 本请求内瞬时故障账号的排除集（强制轮换不粘滞）。
 *  -> { keyId|null, nextCursor, clearSelected, reason:'selected'|'sticky'|'rotate'|null }，clearSelected=true 表示锁定账号已永久失效、需清锁并持久化。 */
function pickAccount(state, opts) {
  const s = state || {};
  const accounts = s.accounts || [];
  const cursor = s.cursor || 0;
  const excludeKeys = (opts && opts.excludeKeys && opts.excludeKeys.size) ? opts.excludeKeys : null;
  const usable = accounts.filter((a) => a.usable).filter((a) => !excludeKeys || !excludeKeys.has(a.key));

  // 锁定失效清理：仅当锁定账号「永久失效」（被删/封号/作废/不存在）才清空锁定——
  // 临时冻结（额度满，nextResetAt 后会恢复）保留锁定，恢复后自动继续用该账号。
  let clearSelected = false;
  if (s.selectedAccountKeyId) {
    const sel = accounts.find((a) => a.keyId === s.selectedAccountKeyId);
    const dead = !sel || sel.status === 'banned' || sel.status === 'discarded' || sel.status === 'registering';
    if (dead) clearSelected = true;
  }
  if (!usable.length) return { keyId: null, nextCursor: cursor, clearSelected, reason: null };

  const selId = clearSelected ? null : (s.selectedAccountKeyId || null);
  if (selId) {
    const sel = usable.find((a) => a.keyId === selId);
    if (sel) return { keyId: sel.keyId, nextCursor: cursor, clearSelected, reason: 'selected' };
  }
  if (s.activeAccountKeyId) {
    const sticky = usable.find((a) => a.keyId === s.activeAccountKeyId);
    if (sticky) return { keyId: sticky.keyId, nextCursor: cursor, clearSelected, reason: 'sticky' };
  }
  // 轮换仅优先选「实例已运行」的账号（process-pool 池）；无就绪账号时降级全可用池（请求侧按需激活）。
  const ready = (a) => s.instancePool !== true || a.running;
  const readyUsable = usable.filter(ready);
  const pool = readyUsable.length ? readyUsable : usable;
  const picked = pool[cursor % pool.length];
  return { keyId: picked.keyId, nextCursor: cursor + 1, clearSelected, reason: 'rotate' };
}

module.exports = { pickAccount };
