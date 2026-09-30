#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 删除实例：必须与「进行中的升级作业」互斥，且不得被平台服务能力异常拖崩
//
// 缺陷（被测对象：InstanceManager.removeInstance）：
//   1) 其它三条路径都有 `tasks.isBusy` 互斥，唯独 removeInstance 没有 -> 升级到 npm install
//      时删除：内存先移除、rmSync 删目录，npm 又把 install/ 重建写入 -> 目录永留盘上而无清理
//      路径（**孤儿永久占盘**）。
//   2) `stopUnit()` 会抛 CapabilityError 的平台（未知平台 NONE / 嵌入方）：removeInstance 原先
//      假定它「不抛」-> 在 mac/win 上**每次删除都抛未捕获异常**。此处显式注入「会抛的 stopUnit」，
//      于是**在 Linux 上也能拦住**该回归。
//
// 锁定不变量：R-a 有在飞作业 -> 拒绝删除且**未**改动实例列表（不留半删状态）· R-b 作业结束后
//   可正常删除（互斥不得变成永久锁）· R-c 反向：不存在的实例仍被如实拒 · R-d stopUnit 抛能力
//   异常时删除不得崩溃。
// ---------------------------------------------------------------------------

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
//   本回归由 macOS runner 逼出：makeUnsupported（macOS launchd / Windows 服务 / 未知平台）的
//   stopUnit() 直接 throw CapabilityError，而 removeInstance 原先假定它「不抛」。W3 起 mac/win
//   落 portable（不抛），但「会抛的 stopUnit」仍是未知平台 NONE 与嵌入方的真实形状，拦截保留。
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
