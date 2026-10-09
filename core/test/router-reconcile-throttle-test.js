#!/usr/bin/env node
'use strict';

// T4/S5 契约回归：智能路由代理实例的 reconcile 必须受统一重启节流（guardian.makeBudget）门控，
// 达到 burst 上限后停止自动拉起（不再无限重生）。此前代理实例 reconcile 无上限、风暴式重生。

const assert = require('node:assert');
const { runReconcileThrottled } = require('../src/domains/router/providers/restart');

let passed = 0;
function ok(c, m) { assert.ok(c, m); passed++; }

// 极简 provider 桩：startInstance 恒失败（模拟端口被占/启动即死），其余方法满足 reconcile 读取。
function fakeProvider(opts) {
  const o = opts || {};
  const acc = { keyId: 'k1', maskedKey: '***k1', status: 'ready' };
  const inst = { keyId: 'k1', pid: null, port: 8080, status: 'COLD', healthy: false };
  return {
    activated: true, _stopping: false, _reconcileBusy: null,
    desiredRunningAccounts: () => ({ active: acc, list: [acc] }),
    instanceOf: () => inst,
    accountOf: () => acc,
    stopInstance() {}, _persist() {},
    _waitHealthy: async () => false,
    startInstance: async () => (o.startOk ? { ok: true } : { ok: false, error: 'simulated start failure' }),
    logger: null,
  };
}

async function main() {
  // 1) 启动恒失败时，连续 reconcile 次数受限（burst=5），达到上限后不再尝试拉起。
  {
    const p = fakeProvider({ startOk: false });
    let totalStartedAttempts = 0;
    const origStart = p.startInstance;
    p.startInstance = async () => { totalStartedAttempts++; return origStart(); };
    // 窗口内连续触发（同一 tickMs 间隔高密度模拟）
    let lastThrottledLen = 0;
    for (let i = 0; i < 20; i++) {
      const r = await runReconcileThrottled(p, true);
      lastThrottledLen = r.throttled.length;
    }
    // burst=5 ⇒ 最多 5 次尝试，之后 throttled 标记实例、不再尝试
    ok(totalStartedAttempts <= 5, '启动失败达到 burst 后停止自动拉起，尝试次数=' + totalStartedAttempts);
    ok(lastThrottledLen === 1, '上限后实例进入 throttled 列表：' + lastThrottledLen);
  }

  // 2) 启动成功时不计入失败预算（活过启动窗口），且实例被标记非 throttled。
  {
    const p = fakeProvider({ startOk: true });
    const r = await runReconcileThrottled(p, true);
    ok(r.started.length === 1, '启动成功计入 started');
    ok(r.throttled.length === 0, '成功实例不在 throttled');
  }

  // 3) 人工重启（resetBudget）后预算清零，可再次尝试。
  {
    const { resetBudget, budgetFor } = require('../src/domains/router/providers/restart');
    const p = fakeProvider({ startOk: false });
    for (let i = 0; i < 6; i++) await runReconcileThrottled(p, true);
    const inst = p.instanceOf();
    ok(budgetFor(inst).tripped === true, '6 次失败后预算 tripped');
    resetBudget(inst);
    ok(budgetFor(inst).tripped === false, 'resetBudget 后预算清零');
    let att = 0; const os = p.startInstance; p.startInstance = async () => { att++; return os(); };
    await runReconcileThrottled(p, true);
    ok(att >= 1, 'reset 后可重新尝试拉起：' + att);
  }

  console.log('PASS router-reconcile-throttle-test: ' + passed + ' assertions');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL router-reconcile-throttle-test:', e && e.message); process.exit(1); });
