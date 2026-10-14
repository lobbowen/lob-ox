'use strict';

const ACTIVE_SLOTS = 1;
const PREWARM_SLOTS = 1;
const SWITCH_BUDGET_MS = 2000;

function byRegisteredAt(a, b) {
  return (a.registeredAt || 0) - (b.registeredAt || 0);
}

function computeDesired(state) {
  const s = state || {};
  const usable = (s.accounts || []).filter((a) => s.isUsable(a)).slice().sort(byRegisteredAt);
  if (!usable.length) return { active: null, prewarm: null, list: [] };
  const totalSlots = ACTIVE_SLOTS + PREWARM_SLOTS;
  let active = null;
  if (s.selectedAccountKeyId) active = usable.find((a) => a.keyId === s.selectedAccountKeyId) || null;
  if (!active && s.activeKeyId) active = usable.find((a) => a.keyId === s.activeKeyId) || null;
  if (!active) active = usable[0];
  const rest = usable.filter((a) => a.keyId !== active.keyId);
  let prewarm = null;
  if (totalSlots > 1) {
    if (s.prewarmKeyId) prewarm = rest.find((a) => a.keyId === s.prewarmKeyId) || null;
    if (!prewarm) prewarm = rest[0] || null;
  }
  const list = [active];
  if (PREWARM_SLOTS > 0 && prewarm) list.push(prewarm);
  return { active, prewarm: PREWARM_SLOTS > 0 ? prewarm : null, list };
}

function isDesired(desired, acc) {
  if (!acc) return false;
  return (desired || []).some((d) => d && d.keyId === acc.keyId);
}

module.exports = { ACTIVE_SLOTS, PREWARM_SLOTS, SWITCH_BUDGET_MS, computeDesired, isDesired };
