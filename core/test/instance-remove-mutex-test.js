#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-rm-'));

// 审计 P0-I5：removeInstance 已为 async（内部 await stopUnit），故整个场景包进 async IIFE。
(async () => {
  {
    const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
    // tasks/service 均在构造期注入（后置赋值不再生效）；必须注入假 provider，绝不触碰开发机 systemd。
    let busy = true;
    const fakeService = {
      daemonReload() { return true; }, stopUnit() { return true; }, resetFailed() { return true; },
      // isUnitActive 现返回 Outcome 三态（根因 A 修法）：false 已被 fail 取代。
      isUnitActive() { return { kind: 'fail', error: 'stub: 未在跑' }; }, transientUnitFile() { return null; }, cleanTransient() {}, startTransient() { return true; },
    };
    const mgr = new InstanceManager({
      dir: path.join(TMP, 'sup'), logger: { info() {}, warn() {}, error() {} },
      tasks: { isBusy: () => busy }, service: fakeService,
    });
    mgr.instances = [{ id: 'i1', name: 'x', domain: 'sandbox', port: 0, state: { phase: 'STOPPED' } }];

    const r1 = await mgr.removeInstance('i1');
    check('R-a 有在飞作业 -> 拒绝删除（不静默）且未改动实例列表（不留半删状态）',
      r1 && r1.ok === false && mgr.instances.length === 1 && mgr.instances[0].id === 'i1', JSON.stringify(r1));

    busy = false;
    const r2 = await mgr.removeInstance('i1');
    check('R-b 无在飞作业 -> 允许删除且列表已清空（互斥不得变成永久锁）',
      r2 && r2.ok === true && mgr.instances.length === 0, JSON.stringify(r2));

    const r3 = await mgr.removeInstance('nope');
    check('R-c 反向：不存在的实例仍被拒（ok:false）', r3 && r3.ok === false, JSON.stringify(r3));
  }

  {
    const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
    const m2 = new InstanceManager({
      dir: path.join(TMP, 'sup2'),
      logger: { info() {}, warn() {}, error() {} },
      tasks: { isBusy: () => false },
      service: {
        stopUnit() { throw new Error('CapabilityError: 测试注入（模拟无服务管理器的平台形状）'); },
        // isUnitActive 现返回 Outcome 三态（根因 A 修法）：false 已被 fail 取代。
        isUnitActive() { return { kind: 'fail', error: 'stub: 未在跑' }; },
      },
    });
    m2.instances = [{ id: 'i9', name: 'x', domain: 'sandbox', port: 0, state: { phase: 'STOPPED' } }];
    let threw = null; let out = null;
    try { out = await m2.removeInstance('i9'); } catch (e) { threw = e; }
    check('R-d stopUnit 抛能力异常时删除不得崩溃（未知平台/嵌入方真实情形）',
      threw === null && out && out.ok === true,
      threw ? ('崩溃: ' + threw.message) : JSON.stringify(out));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
