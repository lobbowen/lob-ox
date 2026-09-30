'use strict';

// 生命周期引擎纯决策（PROXY-LIFECYCLE-STANDARD L-A，与 PROXY-ISOLATION-STANDARD 平级）：期望集 = {在用}+{预热}，反代域进程动作唯一决策源。
// 槽位预算是引擎常量（在用 1 + 预热 1）不是配置；扩槽须修订标准重新裁决，不留暗参数；预热参选按 registeredAt 登记顺序、
// 槽位 sticky；IO（启停/对账）由 restart.js/proxy.js 编排，本文件零 require 进程/IO 模块。

const ACTIVE_SLOTS = 1;
/** 预热槽预算（引擎常量）。存活进程集恒等于期望集：|期望集| <= ACTIVE_SLOTS + PREWARM_SLOTS。 */
const PREWARM_SLOTS = 1;
/** 请求路径同步等待预算（ms）：目标未就绪最多等这么久，超预算换号（转发侧裁决）。 */
const SWITCH_BUDGET_MS = 2000;

function byRegisteredAt(a, b) {
  return (a.registeredAt || 0) - (b.registeredAt || 0);
}

/** 期望集计算。@param state { accounts, isUsable, selectedAccountKeyId, activeKeyId, prewarmKeyId }
 *  @returns { active|null, prewarm|null, list }  list=期望运行账号数组（<=2，在用在前）。
 *  在用归属：用户锁定优先，其次当前在用指针，皆无则可用池登记序首位（保证恒有一个 HOT 服务位）；
 *  预热归属：sticky 仍在可用池且未被提为在用则留任（自身失效才让位），否则可用池（排除在用）按登记顺序补位。 */
function computeDesired(state) {
  const s = state || {};
  const usable = (s.accounts || []).filter((a) => s.isUsable(a)).slice().sort(byRegisteredAt);
  if (!usable.length) return { active: null, prewarm: null, list: [] };
  // 槽位预算在此消费：在用 1 + 预热 <= totalSlots-1；在用必须在全池解析——
  // 先截位再找锁定，登记序第 3 的锁定账号会被静默忽略（用户显式锁号绝不接受无感失效）。
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

/** 账号是否属于期望集（入参为 computeDesired.list 或含 keyId 的账号数组）。 */
function isDesired(desired, acc) {
  if (!acc) return false;
  return (desired || []).some((d) => d && d.keyId === acc.keyId);
}

module.exports = { ACTIVE_SLOTS, PREWARM_SLOTS, SWITCH_BUDGET_MS, computeDesired, isDesired };
