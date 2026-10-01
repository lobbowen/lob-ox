#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 只验证单飞包装本身，故用最小对象复用其原型方法（构造器不跑，_reconcileInFlight 为 undefined 同样是 falsy）。
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

  {
    const { mgr: m2, calls: c2 } = makeHarness(() => Promise.resolve('x'));
    await m2.reconcile();
    await m2.reconcile();
    check('S8-c 完成后可再次发起（不永久占用）', c2.n === 2, c2.n + ' 次');
  }

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
