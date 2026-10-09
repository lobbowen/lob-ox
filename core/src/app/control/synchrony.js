'use strict';

// 单点节拍调度器（T0 / S6 单一时钟）：全守卫进程只保留「这一个」setInterval，
// 所有周期工作（主链收敛 / 心跳 / 壳看门狗 / 升级巡检 / 环境表单刷新）都以
// 命名 beat 形式登记于此，由它统一推进。beats 各自带 cadence（every 拍一次）
// 与可选首跳延迟（firstDelayMs，按 intervalMs 折算成拍数），并共享一把全局互斥锁，
// 杜绝双收敛 / 多时钟竞态。
//
// cadence 以「tick 序号」度量（而非墙钟）：每个 tick() 自增全局序号，beat 满足
// (当前序号 - 上次触发序号) >= every 即触发。这样无论 tick 是被真 setInterval
// 按 5s 间距驱动，还是测试里紧凑循环驱动，语义一致、可判定。
//
// 设计约束（与既有协同）：
//  - 主链收敛仍由 app/main/controller.converge 内部的 host._ticking 互斥保护；
//    本调度器只负责「什么时候调用」，不重复发明收敛锁。
//  - 心跳 beat 内部仍有 ManagedRegistry 自身的 in-flight 守卫 + 本调度器的 per-beat 超时兜底，
//    任一 beat 卡死都不应让其余 beat 停摆（旧 _heartbeatTimer 的防停摆语义在此保留）。
//  - 路由/lan 守护是独立 OS 进程，它们各自的内部计时器是「部署分离」，不是「调度分歧」，
//    不在本进程合并（保留进程分离，仅统一本进程时钟）。

class BeatScheduler {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || null;
    this._beats = new Map(); // name -> { fn, every, firstTicks, _seqSeen, _lastSeq, _fired, timeoutMs }
    this._timer = null;
    this._intervalMs = opts.intervalMs || 5000;
    this._seq = 0;
    this._ticking = false;
    this._stopping = false;
    this.onBeatDone = null;
  }

  register(name, fn, opts) {
    if (typeof fn !== 'function') throw new Error('beat ' + name + ' 需要 fn');
    opts = opts || {};
    const every = (opts.every === Infinity) ? Infinity : Math.max(1, Number(opts.every) || 1);
    const firstDelayMs = (typeof opts.firstDelayMs === 'number' && opts.firstDelayMs >= 0) ? opts.firstDelayMs : null;
    const firstTicks = firstDelayMs !== null ? Math.max(0, Math.ceil(firstDelayMs / this._intervalMs)) : 0;
    this._beats.set(name, {
      fn,
      every,
      firstTicks,
      timeoutMs: (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : 0,
      _seqSeen: 0,
      _lastSeq: null,
      _fired: false,
    });
    return this;
  }

  unregister(name) { this._beats.delete(name); return this; }
  has(name) { return this._beats.has(name); }

  // 全局互斥：所有 beat 与任意 ad-hoc 受保护操作共用这一把锁。
  async withLock(fn) {
    if (this._ticking || this._stopping) return { __skipped: 'busy' };
    this._ticking = true;
    try { return await fn(); }
    finally { this._ticking = false; }
  }

  async tick() {
    if (this._ticking || this._stopping) return { skipped: true, done: [], errors: [] };
    this._ticking = true;
    const done = [];
    const errors = [];
    const iv = this._intervalMs;
    try {
      this._seq++;
      for (const [name, b] of this._beats) {
        b._seqSeen++;
        if (b.every === Infinity) {
          if (b._fired || b._seqSeen <= b.firstTicks) continue;
          b._fired = true;
        } else {
          if (b._seqSeen <= b.firstTicks) continue;
          if (b._lastSeq !== null && (this._seq - b._lastSeq) < b.every) continue;
          b._lastSeq = this._seq;
        }
        let p;
        try { p = Promise.resolve(b.fn()); }
        catch (e) { errors.push(name + ':' + (e && e.message)); continue; }
        if (b.timeoutMs && b.timeoutMs > 0) {
          p = Promise.race([p, new Promise((res) => {
            const t = setTimeout(() => res({ __beatTimeout: true }), b.timeoutMs);
            if (t.unref) t.unref();
          })]);
        }
        try {
          const r = await p;
          if (r && r.__beatTimeout) {
            errors.push(name + ':timeout');
            if (this.logger && this.logger.warn) this.logger.warn('[beat] ' + name + ' 超过 ' + b.timeoutMs + 'ms，已跳过本拍（防停摆）');
          } else {
            done.push(name);
          }
        } catch (e) {
          errors.push(name + ':' + (e && e.message));
          if (this.logger && this.logger.warn) this.logger.warn('[beat] ' + name + ': ' + (e && e.message));
        }
      }
    } finally {
      this._ticking = false;
    }
    if (this.onBeatDone) {
      try { await this.onBeatDone({ done, errors }); }
      catch (e) { if (this.logger && this.logger.warn) this.logger.warn('[beat] onBeatDone: ' + (e && e.message)); }
    }
    return { done, errors };
  }

  start(intervalMs) {
    this._intervalMs = intervalMs || this._intervalMs;
    this._stopping = false;
    if (this._timer) clearInterval(this._timer);
    const self = this;
    this._timer = setInterval(() => { self.tick(); }, this._intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    return this;
  }

  stop() {
    this._stopping = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  resume() { this._stopping = false; }
  clear() { this._beats.clear(); this.stop(); }
}

module.exports = { BeatScheduler };
