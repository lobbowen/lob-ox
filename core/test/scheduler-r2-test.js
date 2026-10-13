'use strict';
// R2 行为测试：调度器重构的三条不变量。
const assert = require('node:assert');
const { BeatScheduler } = require('C:/work/lob-ox/core/src/app/control/synchrony.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(name + ': ' + (e && e.message)); }
}

// 1. timeoutMs 必填——缺省即抛错（把运行期停摆提前到装配期）
check('register 缺 timeoutMs 抛错', () => {
  const s = new BeatScheduler({ intervalMs: 100 });
  assert.throws(() => s.register('x', () => {}, { every: 1 }), /timeoutMs/);
});
check('register timeoutMs 为 0 也抛错', () => {
  const s = new BeatScheduler({ intervalMs: 100 });
  assert.throws(() => s.register('x', () => {}, { every: 1, timeoutMs: 0 }), /timeoutMs/);
});
check('register 合法 timeoutMs 通过', () => {
  const s = new BeatScheduler({ intervalMs: 100 });
  s.register('x', () => {}, { every: 1, timeoutMs: 1000 });
  assert.ok(s.has('x'));
});

// 2. afterTick 注册列表是单一事实源
check('afterTick 重复注册抛错', () => {
  const s = new BeatScheduler({ intervalMs: 100 });
  s.afterTick('a', () => {});
  assert.throws(() => s.afterTick('a', () => {}), /重复注册/);
});
check('afterTick 非函数抛错', () => {
  const s = new BeatScheduler({ intervalMs: 100 });
  assert.throws(() => s.afterTick('a', 'nope'), /需要 fn/);
});

// 3. 独立竞速：慢 beat 不阻塞快 beat，也不阻塞 afterTick
check('慢 beat 不阻塞 afterTick 与快 beat', async () => {
  const s = new BeatScheduler({ intervalMs: 10 });
  const order = [];
  s.register('slow', () => new Promise((r) => setTimeout(() => { order.push('slow'); r(); }, 300)), { every: 1, timeoutMs: 1000 });
  s.register('fast', () => { order.push('fast'); }, { every: 1, timeoutMs: 1000 });
  s.afterTick('hook', () => { order.push('afterTick'); });
  const r = await s.tick();
  assert.deepStrictEqual(r.done.sort(), ['fast', 'slow']);
  assert.ok(order.indexOf('fast') < order.indexOf('slow'), 'fast 应早于 slow 完成');
  assert.strictEqual(order[order.length - 1], 'afterTick', 'afterTick 必须在所有 beat 之后');
});

// 4. 超时只砍自己：slow 超时不影响 fast 与 afterTick
check('beat 超时只记自己不拖累他人', async () => {
  const s = new BeatScheduler({ intervalMs: 10 });
  const order = [];
  s.register('slow', () => new Promise((r) => setTimeout(() => { order.push('slow'); r(); }, 500)), { every: 1, timeoutMs: 50 });
  s.register('fast', () => { order.push('fast'); }, { every: 1, timeoutMs: 1000 });
  s.afterTick('hook', () => { order.push('afterTick'); });
  const r = await s.tick();
  assert.ok(r.errors.some((e) => e.startsWith('slow:timeout')), 'slow 应记 timeout: ' + JSON.stringify(r.errors));
  assert.ok(r.done.includes('fast'), 'fast 应成功');
  assert.strictEqual(order[order.length - 1], 'afterTick', 'afterTick 仍须执行');
});

// 5. 多个 afterTick 按注册顺序执行，单个失败不影响其他
check('afterTick 顺序执行且单个失败不中断', async () => {
  const s = new BeatScheduler({ intervalMs: 10 });
  const order = [];
  s.afterTick('first', () => { order.push('first'); });
  s.afterTick('boom', () => { order.push('boom'); throw new Error('x'); });
  s.afterTick('third', () => { order.push('third'); });
  await s.tick();
  assert.deepStrictEqual(order, ['first', 'boom', 'third']);
});

// 6. onBeatDone 字段已删除（挂错对象的根源消除）
check('onBeatDone 单值字段已移除', () => {
  const s = new BeatScheduler({ intervalMs: 10 });
  assert.strictEqual(s.onBeatDone, undefined, 'onBeatDone 应已删除，改用 afterTick');
  assert.ok(Array.isArray(s._afterTick), '应有 _afterTick 列表');
});

// 7. every 节流仍然生效
check('every 节流生效', async () => {
  const s = new BeatScheduler({ intervalMs: 10 });
  let n = 0;
  s.register('tick3', () => { n++; }, { every: 3, timeoutMs: 1000 });
  await s.tick();                       // 第 1 拍：_lastSeq 为 null，触发
  assert.strictEqual(n, 1, '第一拍应触发');
  await s.tick(); await s.tick();       // 第 2、3 拍：距上次不足 3，不触发
  assert.strictEqual(n, 1, '第 2、3 拍不应触发');
  await s.tick();                       // 第 4 拍：距上次已 3 拍，触发
  assert.strictEqual(n, 2, '第 4 拍应再触发');
});

setTimeout(() => {
  console.log('R2 调度器测试：' + passed + ' 通过，' + failures.length + ' 失败');
  if (failures.length) { console.log(failures.map((f) => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL R2 SCHEDULER TESTS PASS');
}, 1200);
