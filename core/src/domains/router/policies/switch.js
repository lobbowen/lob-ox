'use strict';

function pickAccount(state, opts) {
  const s = state || {};
  const accounts = s.accounts || [];
  const cursor = s.cursor || 0;
  const excludeKeys = (opts && opts.excludeKeys && opts.excludeKeys.size) ? opts.excludeKeys : null;
  const usable = accounts.filter((a) => a.usable).filter((a) => !excludeKeys || !excludeKeys.has(a.key));

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
  const ready = (a) => s.instancePool !== true || a.running;
  const readyUsable = usable.filter(ready);
  const pool = readyUsable.length ? readyUsable : usable;
  const picked = pool[cursor % pool.length];
  return { keyId: picked.keyId, nextCursor: cursor + 1, clearSelected, reason: 'rotate' };
}

module.exports = { pickAccount };
