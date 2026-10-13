'use strict';
// R5 行为测试：账号状态机单一出口的三条不变量。
const assert = require('node:assert');
const freeze = require('C:/work/lob-ox/core/src/domains/router/providers/policies/freeze.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(name + ': ' + (e && e.message)); }
}

// 构造一个最小 provider 桩，记录副作用调用
function mkProvider(over) {
  const p = Object.assign({
    name: 'test',
    accounts: [],
    activeAccount: null,
    selectedAccountKeyId: null,
    events: { append: (t, d) => { (p._events = p._events || []).push(t); } },
    logger: { info: () => {}, warn: () => {} },
    _persist: () => { (p._persists = (p._persists || 0) + 1); },
    _onStatusTransition: (acc, from, to) => { (p._transitions = p._transitions || []).push(from + '>' + to); },
    _isCreditsLow: () => false,
    _windowExhausted: () => false,
    _nextResetAt: () => ({ precise: false, t: 0 }),
    markNotInUse: (id) => { (p._markNotInUse = p._markNotInUse || []).push(id); if (p.activeAccount && p.activeAccount.keyId === id) p.activeAccount = null; },
    isAccountUsable: () => true,
  }, over || {});
  return p;
}
function mkAcc(over) {
  return Object.assign({ keyId: 'k1', maskedKey: '***k1', status: 'ready', limit: null, nextResetAt: null, quota: null }, over || {});
}

// ============ 不变量 1：banned 不被探测解封（D.5-P1-14） ============
check('banned 账号探测成功不解封', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'banned', limit: { kind: 'banned', recovery: { type: 'manual' } } });
  const next = freeze.deriveNext(acc, { ok: true, quota: {} }, p);
  assert.strictEqual(next, null, 'deriveNext 对 banned 必须返回 null（不接受探测恢复）');
  freeze.applyDetection(acc, { ok: true, quota: {} }, p);
  assert.strictEqual(acc.status, 'banned', 'applyDetection 后 status 应仍为 banned');
});
check('banned 账号显式人工恢复可解封', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'banned', limit: { kind: 'banned', recovery: { type: 'manual' } } });
  // 人工恢复 = 直接 transition 到 ready（discardAccount 之外的显式路径）
  const r = freeze.transition(acc, { status: 'ready', limit: null, nextResetAt: null, autoRecover: true }, p);
  assert.strictEqual(acc.status, 'ready');
  assert.strictEqual(acc.limit, null, 'limit 应被清空');
  assert.ok(r.changed);
});

// ============ 不变量 2：transition 副作用穷举（D.7-P1-13） ============
check('transition 到 frozen 触发全部副作用', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'ready' });
  p.activeAccount = acc;                 // 是 activeAccount
  p.selectedAccountKeyId = 'k1';          // 且被锁定
  const r = freeze.transition(acc, { status: 'frozen', limit: { kind: 'window', reason: 'x', recovery: { type: 'poll', periodMs: 1000 } }, nextResetAt: Date.now() + 1000 }, p);
  assert.ok(r.effects.includes('markNotInUse'), '应调 markNotInUse');
  assert.ok(r.effects.includes('clearSelected'), '应清 selectedAccountKeyId');
  assert.ok(r.effects.includes('onStatusTransition'), '应触发 _onStatusTransition（实例回收的入口）');
  assert.ok(r.effects.includes('event'), '应发事件');
  assert.strictEqual(p.activeAccount, null, 'activeAccount 应被清');
  assert.strictEqual(p.selectedAccountKeyId, null, 'selectedAccountKeyId 应被清');
  assert.strictEqual(acc.status, 'frozen');
});
check('normalizeConsistency 走 transition 后副作用齐全', () => {
  const p = mkProvider({ _isCreditsLow: () => true });
  const acc = mkAcc({ status: 'ready', quota: { monthlyRemaining: 0 } });
  p.activeAccount = acc;
  p.selectedAccountKeyId = 'k1';
  freeze.normalizeConsistency(acc, p);
  assert.strictEqual(acc.status, 'frozen', '应归位 frozen');
  assert.strictEqual(p.activeAccount, null, 'activeAccount 应被清（原缺陷：裸赋值跳过）');
  assert.strictEqual(p.selectedAccountKeyId, null, 'selectedAccountKeyId 应被清（原缺陷：裸赋值跳过）');
  assert.ok((p._transitions || []).length > 0, '_onStatusTransition 应被触发（原缺陷：裸赋值跳过）');
});
check('transition 幂等：相同迁移不重复触发事件', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'frozen', limit: { kind: 'window', since: 1, reason: 'x', recovery: null } });
  const n0 = (p._events || []).length;
  const r = freeze.transition(acc, { status: 'frozen', limit: { kind: 'window', reason: 'x', recovery: null } }, p);
  assert.strictEqual((p._events || []).length, n0, '相同状态不应再发事件');
  assert.strictEqual(r.changed, false, '应报告未变更');
});

// ============ 不变量 3：creditsAt 跨 kind 保留（D.9-1） ============
check('setLimit 跨 kind 保留 creditsAt', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'frozen', limit: { kind: 'credits', since: 1, creditsAt: 0, reason: 'r', recovery: null } });
  // 双耗尽：kind 从 credits 覆盖为 window
  freeze.setLimit(acc, 'window', 'window reason', { type: 'at', at: 123 }, p);
  assert.strictEqual(acc.limit.kind, 'window');
  assert.strictEqual(acc.limit.creditsAt, 0, 'creditsAt 应跨 kind 保留（原缺陷：kind 不匹配即丢）');
});
check('transition 也保留 creditsAt', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'frozen', limit: { kind: 'credits', since: 1, creditsAt: 0, reason: 'r', recovery: null } });
  freeze.transition(acc, { status: 'frozen', limit: { kind: 'window', reason: 'w', recovery: { type: 'at', at: 1 } } }, p);
  assert.strictEqual(acc.limit.kind, 'window');
  assert.strictEqual(acc.limit.creditsAt, 0, 'transition 路径同样应保留 creditsAt');
});

// ============ 不变量 4：deriveNext 的恢复判据（充值后能恢复） ============
check('credits 冻结 + 已充值 → 推导恢复 ready', () => {
  const p = mkProvider({ _isCreditsLow: () => false, _windowExhausted: () => false });
  const acc = mkAcc({
    status: 'frozen',
    limit: { kind: 'credits', since: 1, creditsAt: 0, reason: 'r', recovery: { type: 'poll', periodMs: 1000 } },
    quota: { monthlyRemaining: 5, credits: { monthlyCredits: 5 } },
  });
  const next = freeze.deriveNext(acc, { ok: true, quota: acc.quota }, p);
  assert.ok(next, '应推导出下一状态');
  assert.strictEqual(next.status, 'ready', '充值后应推导恢复 ready');
  assert.strictEqual(next.limit, null, 'limit 应清空');
});
check('credits 冻结 + 未充值 → 保持 frozen', () => {
  const p = mkProvider({ _isCreditsLow: () => true });
  const acc = mkAcc({
    status: 'frozen',
    limit: { kind: 'credits', since: 1, creditsAt: 0, reason: 'r', recovery: { type: 'poll', periodMs: 1000 } },
    quota: { monthlyRemaining: 0 },
  });
  const next = freeze.deriveNext(acc, { ok: true, quota: acc.quota }, p);
  assert.strictEqual(next.status, 'frozen', '未充值应保持 frozen');
  assert.strictEqual(next.limit.kind, 'credits');
});

// ============ 不变量 5：探测失败不改状态 ============
check('探测失败只记错不改状态', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'ready' });
  freeze.applyDetection(acc, { ok: false, error: 'timeout' }, p);
  assert.strictEqual(acc.status, 'ready', '探测失败不应改状态');
  assert.strictEqual(acc.lastProbeError, 'timeout');
});
check('探测失败且 banned 标记 → 转 banned', () => {
  const p = mkProvider();
  const acc = mkAcc({ status: 'ready' });
  freeze.applyDetection(acc, { ok: false, banned: true, error: '401' }, p);
  assert.strictEqual(acc.status, 'banned');
  assert.strictEqual(acc.limit.kind, 'banned');
  assert.strictEqual(acc.limit.recovery.type, 'manual');
});

console.log('R5 账号状态机测试：' + passed + ' 通过，' + failures.length + ' 失败');
if (failures.length) { console.log(failures.map((f) => '  x ' + f).join('\n')); process.exit(1); }
console.log('ALL R5 ACCOUNT STATE TESTS PASS');
