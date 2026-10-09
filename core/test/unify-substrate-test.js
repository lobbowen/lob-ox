#!/usr/bin/env node
'use strict';

// T0/S6/S5 统一控制基底层契约测试：单一节拍调度器 + 全局互斥 + 统一节流预算。
// 纯逻辑、零真宿主依赖（应归入 L1/os=all）。

const assert = require('node:assert');
const { BeatScheduler } = require('../src/app/control/synchrony');
const { makeBudget, bumpStartupFailure } = require('../src/shared/guardian');

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }

async function main() {
  // --- BeatScheduler：cadence + firstDelay(按 tick 折) + infinity(只跑一次) ---
  {
    const s = new BeatScheduler({ intervalMs: 10 });
    let mainHits = 0, slowHits = 0, onceHits = 0;
    s.register('main', () => { mainHits++; }, { every: 1 });
    s.register('slow', () => { slowHits++; }, { every: 3 });
    s.register('once', () => { onceHits++; }, { every: Infinity, firstDelayMs: 20 });
    for (let i = 0; i < 30; i++) await s.tick();
    ok(mainHits === 30, 'main every=1 应每拍触发：' + mainHits);
    ok(slowHits === 10, 'slow every=3 应触发 10 次：' + slowHits);
    ok(onceHits === 1, 'every=Infinity 只跑一次：' + onceHits);

    // firstDelayMs 按 tick 计数折算（生产里 tick 由真 interval 按 intervalMs 间距驱动，等价墙钟延迟）
    const s2 = new BeatScheduler({ intervalMs: 10 });
    let delayed = 0;
    s2.register('d', () => { delayed++; }, { every: 1, firstDelayMs: 50 }); // firstTicks = ceil(50/10)=5
    for (let i = 0; i < 5; i++) await s2.tick();
    ok(delayed === 0, 'firstDelay 头 5 拍不触发：' + delayed);
    await s2.tick();
    ok(delayed === 1, '第 6 拍首次触发：' + delayed);
    for (let i = 0; i < 4; i++) await s2.tick();
    ok(delayed === 5, '之后每拍触发：' + delayed);
  }

  // --- 全局互斥：重入被跳过（杜绝双收敛） ---
  {
    // 先占锁（异步持有一段时间），再并发请求 withLock ⇒ 后来的应被跳过
    const s = new BeatScheduler({ intervalMs: 5 });
    let started = false, released = false;
    const held = s.withLock(async () => { started = true; await new Promise((r) => setTimeout(r, 40)); released = true; });
    // 锁持有期间再来一次
    const r2 = await s.withLock(() => Promise.resolve('work'));
    await held;
    ok(r2 && r2.__skipped === 'busy', '锁占用时 withLock 跳过：' + JSON.stringify(r2));
    ok(started && released, '首个 withLock 正常持锁执行');

    // tick 进行中其它 withLock 跳过
    const s3 = new BeatScheduler({ intervalMs: 5 });
    s3.register('x', () => new Promise((res) => setTimeout(res, 30)), { every: 1 });
    s3._ticking = true; // 模拟 tick 进行中
    const r3 = await s3.withLock(() => Promise.resolve('work'));
    ok(r3 && r3.__skipped === 'busy', 'tick 进行中 withLock 跳过');
  }

  // --- 防停摆：单 beat 超时不影响其余 beat ---
  {
    const s = new BeatScheduler({ intervalMs: 5 });
    let fastHits = 0;
    s.register('fast', () => { fastHits++; }, { every: 1 });
    s.register('slow', () => new Promise((res) => setTimeout(res, 200)), { every: 1, timeoutMs: 50 });
    for (let i = 0; i < 20; i++) await s.tick();
    ok(fastHits === 20, 'fast beat 不受 slow 超时影响：' + fastHits);
  }

  // --- 统一节流预算 makeBudget：窗口内 N 次 ⇒ tripped，非启动失败不计数 ---
  {
    const b = makeBudget({ windowMs: 1000, burst: 3 });
    ok(b.tripped === false, '初始未 tripped');
    let r = b.note(true);
    ok(r.tripped === false && r.count === 1, '第 1 次失败');
    r = b.note(true);
    ok(r.count === 2 && !r.tripped, '第 2 次失败');
    r = b.note(true);
    ok(r.tripped === true && r.halted === true && r.count === 3, '第 3 次触发上限');
    await new Promise((r) => setTimeout(r, 1100));
    r = b.note(true);
    ok(r.count === 1 && !r.tripped, '窗口过期后计数重置');
    const b2 = makeBudget({ windowMs: 1000, burst: 2 });
    b2.note(false); b2.note(false);
    ok(b2.count === 0 && !b2.tripped, 'normal restart 不计失败');
  }

  // --- 回归：makeBudget 与既有 bumpStartupFailure 同源 ---
  {
    const b = makeBudget({ windowMs: 60000, burst: 5 });
    let r = b.note(true);
    for (let i = 1; i < 5; i++) r = b.note(true);
    ok(r.tripped === true, '5 次触发（与 bumpStartupFailure 默认档一致）');
    const dec = bumpStartupFailure({ start: Date.now(), count: 4 }, Date.now() + 1, { windowMs: 60000, burst: 5 });
    ok(dec.tripped === true && dec.count === 5, 'bumpStartupFailure 等价');
  }

  console.log('PASS unify-substrate-test: ' + passed + ' assertions');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL unify-substrate-test:', e && e.message); process.exit(1); });
