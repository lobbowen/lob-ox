'use strict';

const ACTIVE_SLOTS = 1;
const PREWARM_SLOTS = 1;
const SWITCH_BUDGET_MS = 2000;

function byRegisteredAt(a, b) {
  return (a.registeredAt || 0) - (b.registeredAt || 0);
}

// list 完全由常量推导：ACTIVE_SLOTS 个在用 + PREWARM_SLOTS 个预热。
// 此前硬编码 [active, prewarm] 两条，使 ACTIVE_SLOTS>1 被静默忽略——
// 常量是导出的、看起来像判据，实际不起作用。
function computeDesired(state) {
  const s = state || {};
  const usable = (s.accounts || []).filter((a) => s.isUsable(a)).slice().sort(byRegisteredAt);
  if (!usable.length) return { active: null, prewarm: null, activeList: [], prewarmList: [], list: [] };
  let active = null;
  if (s.selectedAccountKeyId) active = usable.find((a) => a.keyId === s.selectedAccountKeyId) || null;
  if (!active && s.activeKeyId) active = usable.find((a) => a.keyId === s.activeKeyId) || null;
  if (!active) active = usable[0];
  const rest = usable.filter((a) => a.keyId !== active.keyId);

  // 在用槽：selected/active 优先，其余按注册顺序补足到 ACTIVE_SLOTS。
  const activeList = [active];
  for (const a of rest) { if (activeList.length >= ACTIVE_SLOTS) break; activeList.push(a); }

  // 预热槽：紧接在用槽之后，同样只认 prewarmKeyId 优先 + 常量补足。
  const prewarmList = [];
  if (PREWARM_SLOTS > 0) {
    const restAfter = usable.filter((a) => !activeList.some((x) => x.keyId === a.keyId));
    if (s.prewarmKeyId) { const p = restAfter.find((a) => a.keyId === s.prewarmKeyId); if (p) prewarmList.push(p); }
    for (const a of restAfter) { if (prewarmList.length >= PREWARM_SLOTS) break; if (prewarmList.indexOf(a) < 0) prewarmList.push(a); }
  }

  return { active, prewarm: prewarmList[0] || null, activeList, prewarmList, list: activeList.concat(prewarmList) };
}

function isDesired(desired, acc) {
  if (!acc) return false;
  return (desired || []).some((d) => d && d.keyId === acc.keyId);
}

module.exports = { ACTIVE_SLOTS, PREWARM_SLOTS, SWITCH_BUDGET_MS, computeDesired, isDesired };
