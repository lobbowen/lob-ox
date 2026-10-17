'use strict';

// R2 重构：三处缺陷一次修掉。
//
// 缺陷 1（D.5-P1-17）timeoutMs 形同虚设：原实现 timeoutMs 缺省为 0，而 router 的三个
//   beat 都没传，于是「防停摆」机制从未生效。tick 对每个 beat 顺序 await，一个慢
//   beat（monitorInstanceHealth 逐 provider await，N 个实例最坏 3N 秒）会饿死 main
//   beat——内核的状态收敛、升级检查、被管对象监督全停摆。
//
// 缺陷 2（D.11-P0-12）onBeatDone 挂错对象：compose/domains.js 曾把 onBeatDone 赋给
//   一个没有该属性的对象，而 BeatScheduler 自己持有的这个字段无人赋值，导致
//   governSweep 整套资源配额体系在生产中永不执行。
//
// 缺陷 3（D.11-P3-10）scheduler.js 注入 12 个依赖只用 1 个，五个注入点全死。
//
// 修法（底层，非补丁）：
//   a. timeoutMs 必填——缺省即抛错，把运行期停摆提前到装配期失败；
//   b. beat 之间独立竞速——每个 beat 各自 Promise.race(timeout)，互不等待，
//      删掉 _ticking 整拍跳过（独立竞速后不需要，且它正是饿死的机制）；
//   c. afterTick 显式注册列表——「挂了但没人读」与「读了但没人挂」两种失效
//      都不可能，注册列表是单一事实源。onBeatDone 单值字段已删除。

class BeatScheduler {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || null;
    this._beats = new Map();
    this._timer = null;
    this._intervalMs = opts.intervalMs || 5000;
    this._seq = 0;
    this._stopping = false;
    this._afterTick = [];
  }

  register(name, fn, opts) {
    if (typeof fn !== 'function') throw new Error('beat ' + name + ' 需要 fn');
    opts = opts || {};
    // a. timeoutMs 必填。防停摆机制必须被显式声明，缺省即装配失败。
    const timeoutMs = opts.timeoutMs;
    if (!(typeof timeoutMs === 'number' && timeoutMs > 0)) {
      throw new Error('beat ' + name + ' 必须显式声明 timeoutMs（正整数）——防停摆机制不可缺省');
    }
    const every = (opts.every === Infinity) ? Infinity : Math.max(1, Number(opts.every) || 1);
    const firstDelayMs = (typeof opts.firstDelayMs === 'number' && opts.firstDelayMs >= 0) ? opts.firstDelayMs : null;
    const firstTicks = firstDelayMs !== null ? Math.max(0, Math.ceil(firstDelayMs / this._intervalMs)) : 0;
    this._beats.set(name, {
      fn,
      every,
      firstTicks,
      timeoutMs,
      _seqSeen: 0,
      _lastSeq: null,
      _fired: false,
    });
    return this;
  }

  // c. afterTick 显式注册。返回 this 以便链式调用；注册时校验是函数，
  // 让「名字写错」在装配期炸而不是运行期静默。
  afterTick(name, fn) {
    if (typeof fn !== 'function') throw new Error('afterTick ' + name + ' 需要 fn');
    if (this._afterTick.some((h) => h.name === name)) {
      throw new Error('afterTick ' + name + ' 重复注册——每个善后只应有一个所有者');
    }
    this._afterTick.push({ name, fn });
    return this;
  }

  unregister(name) { this._beats.delete(name); return this; }
  has(name) { return this._beats.has(name); }

  // 注：原 withLock 已删除——它零消费方，且依赖 _ticking 字段（R2 后该字段已移除，
  // 因为独立竞速模型不再需要「整拍互斥」）。

  // b. 独立竞速：本拍所有到期的 beat 同时启动，每个各自与自己的 timeout race，
  // 互不等待。慢 beat 只拖累自己，不再饿死 main。
  // 删除了原 _ticking 整拍跳过逻辑——它正是饿死机制：一次未完成的 tick 会让
  // 整拍（含 main）被跳过，而慢 beat 往往每拍都完不成。
  async tick() {
    if (this._stopping) return { skipped: true, done: [], errors: [] };
    this._seq++;
    const due = [];
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
      due.push([name, b]);
    }
    if (!due.length && !this._afterTick.length) return { done: [], errors: [] };

    const done = [];
    const errors = [];
    await Promise.all(due.map(async ([name, b]) => {
      let p;
      try { p = Promise.resolve(b.fn()); }
      catch (e) {
        errors.push(name + ':' + (e && e.message));
        if (this.logger && this.logger.warn) this.logger.warn('[beat] ' + name + ': ' + (e && e.message));
        return;
      }
      try {
        const r = await Promise.race([p, new Promise((res) => {
          const t = setTimeout(() => res({ __beatTimeout: true }), b.timeoutMs);
          if (t.unref) t.unref();
        })]);
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
    }));

    // c. afterTick 顺序执行（善后之间有依赖顺序），单个失败不影响其他善后。
    for (const h of this._afterTick) {
      try { await h.fn({ done, errors }); }
      catch (e) {
        if (this.logger && this.logger.warn) this.logger.warn('[beat] afterTick ' + h.name + ': ' + (e && e.message));
      }
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
