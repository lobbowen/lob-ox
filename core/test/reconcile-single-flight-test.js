#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// LanManager.reconcile 的**单飞**（single-flight）
//
// ## 缺陷
//
// `reconcile()` 内含逐实例 `await targetReachable(inst)`（每个最多 600ms TCP 超时），
// 而它被多个 **2 秒级**节拍触发：
//   - 前端 UI 每 2s 轮询 `/lan/list` -> `list()` 内部调 reconcile（manager.js:64）；
//   - lan-daemon 自身每 2s tick（daemon.js:127）；
//   - supervisor / adapters / converge-view 亦各有一处。
//
// N 个不可达实例时，多轮 reconcile 重叠 -> 串行等待堆在事件循环上 ->
// ctl / 面板响应变慢。
//
// ## 修法
//
// 单飞：同一时刻只允许一轮在跑，后续调用**复用**在途 Promise。
// 语义安全：对账是幂等的「收敛到期望」，少跑一轮不会漏收敛（下轮节拍补上）。
//
// ## 锁定不变量
//   S8-a 并发 N 次 reconcile：底层执行体只被调用 1 次
//   S8-b 在途期间返回的是**同一个** Promise，且调用方能 await 到真实结果
//   S8-c 完成后可再次发起（单飞只合并重叠，不永久占用）
//   S8-d 执行体抛错后仍能恢复对账（不会永久卡住后续对账）
//
//  （原判据读私有字段 `_reconcileInFlight` 断言「已清空」—— 私有字段一改名/一重构即红、
//    而产品无恙，属实现耦合；S8-c/S8-d 已从行为上证明状态未卡死，故删该条与夹具里的同名预置。）
// ---------------------------------------------------------------------------

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// -- 行为级：直接实例化 LanManager，替换对账主体，验证单飞语义 --
//   说明：reconcile 依赖 this.instances/_allManaged/logger 等；
//   此处只验证**单飞包装本身**，故用一个最小对象复用其原型方法
//   （构造器不跑，`_reconcileInFlight` 为 undefined —— 与初始值 null 同样是 falsy）。
const { LanManager } = require(path.join(ROOT, 'src', 'domains', 'relay', 'ops.js'));
const proto = LanManager.prototype;

const makeHarness = (impl) => {
  const calls = { n: 0 };
  const mgr = Object.create(proto);
  mgr.logger = { warn() {}, info() {}, debug() {} };
  mgr._reconcileOnce = function () { calls.n++; return impl(); };
  return { mgr, calls };
};

(async () => {
  // a/b：两个并发调用 -> 主体只跑 1 次，且拿到**同一个** Promise（同一实例则 await 必得真结果）
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { mgr, calls } = makeHarness(() => gate.then(() => 'done'));
    const p1 = mgr.reconcile();
    const p2 = mgr.reconcile();
    const same = p1 === p2;
    release();
    const v = await p1;
    check('S8-a 并发调用返回同一个 Promise，且底层执行体只被调用 1 次',
      same && calls.n === 1, (same ? '同一实例' : '不同实例') + ' calls=' + calls.n);
    check('S8-b 调用方能 await 到真实结果（单飞不得吞掉结果）', v === 'done', String(v));
  }

  // c：完成后可再次发起
  {
    const { mgr: m2, calls: c2 } = makeHarness(() => Promise.resolve('x'));
    await m2.reconcile();
    await m2.reconcile();
    check('S8-c 完成后可再次发起（不永久占用）', c2.n === 2, c2.n + ' 次');
  }

  // d：执行体抛错后仍能恢复对账（旧实现会永久卡住）
  {
    let failFirst = true;
    const { mgr: m3, calls: c3 } = makeHarness(() => {
      if (failFirst) { failFirst = false; return Promise.reject(new Error('boom')); }
      return Promise.resolve('recovered');
    });
    await m3.reconcile().catch(() => {});
    const v3 = await m3.reconcile();
    check('S8-d 抛错后仍能恢复对账（单飞状态未卡死）', v3 === 'recovered' && c3.n === 2, v3 + '/' + c3.n);
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
