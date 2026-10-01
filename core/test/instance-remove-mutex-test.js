#!/usr/bin/env node
'use strict';

// 删除实例：必须与「进行中的升级作业」互斥，且不得被平台服务能力异常拖崩 —— removeInstance 原先既
//   没有 tasks.isBusy 互斥（升级中删除 -> npm 重建 install/ -> 孤儿永久占盘），又假定 stopUnit 不抛
//   CapabilityError。R-a 在飞作业拒绝删除且不留半删 · R-b 作业结束可删 · R-c 不存在仍如实拒 · R-d stopUnit 抛异常不崩溃。

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

// -- R-a / R-b / R-c：与在飞作业互斥 --
{
  const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
  //  域改造后 tasks/service 均在**构造期**注入（createOps/createLifecycle 捕获 ctx）——
  //   后置赋值 mgr.tasks 不再生效，且 removeInstance 经注入的 service 停单元；
  //   必须注入假 provider，绝不触碰开发机 systemd。
  let busy = true;
  const fakeService = {
    daemonReload() { return true; }, stopUnit() { return true; }, resetFailed() { return true; },
    isUnitActive() { return false; }, transientUnitFile() { return null; }, cleanTransient() {}, startTransient() { return true; },
  };
  const mgr = new InstanceManager({
    dir: path.join(TMP, 'sup'), logger: { info() {}, warn() {}, error() {} },
    tasks: { isBusy: () => busy }, service: fakeService,
  });
  mgr.instances = [{ id: 'i1', name: 'x', domain: 'sandbox', port: 0, state: { phase: 'STOPPED' } }];

  const r1 = mgr.removeInstance('i1');
  check('R-a 有在飞作业 -> 拒绝删除（不静默）且未改动实例列表（不留半删状态）',
    r1 && r1.ok === false && mgr.instances.length === 1 && mgr.instances[0].id === 'i1', JSON.stringify(r1));

  // 作业结束后可正常删除
  busy = false;
  const r2 = mgr.removeInstance('i1');
  check('R-b 无在飞作业 -> 允许删除且列表已清空（互斥不得变成永久锁）',
    r2 && r2.ok === true && mgr.instances.length === 0, JSON.stringify(r2));

  // 反向：不存在的实例仍被如实拒（守卫不得掩盖该语义）
  const r3 = mgr.removeInstance('nope');
  check('R-c 反向：不存在的实例仍被拒（ok:false）', r3 && r3.ok === false, JSON.stringify(r3));
}

// -- R-d：stopUnit 抛「平台不支持」时，删除**不得崩溃** --
//   makeUnsupported（macOS launchd / Windows 服务 / 未知平台）的真实形状；mac/win 现落 portable（不抛），拦截保留。
{
  const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
  // 经**构造期注入**伪造平台服务（本仓约定：显式注入，而非 patch 模块导出 ——
  // 后者在值绑定时会静默失效并跑真实副作用）。
  const m2 = new InstanceManager({
    dir: path.join(TMP, 'sup2'),
    logger: { info() {}, warn() {}, error() {} },
    tasks: { isBusy: () => false },
    service: {
      stopUnit() { throw new Error('CapabilityError: 测试注入（模拟无服务管理器的平台形状）'); },
      isUnitActive() { return false; },
    },
  });
  m2.instances = [{ id: 'i9', name: 'x', domain: 'sandbox', port: 0, state: { phase: 'STOPPED' } }];
  let threw = null; let out = null;
  try { out = m2.removeInstance('i9'); } catch (e) { threw = e; }
  check('R-d stopUnit 抛能力异常时删除不得崩溃（未知平台/嵌入方真实情形）',
    threw === null && out && out.ok === true,
    threw ? ('崩溃: ' + threw.message) : JSON.stringify(out));
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
