'use strict';

class BeatScheduler {
  constructor(opts) {
    opts = opts || {};
    this.logger = opts.logger || null;
    this._beats = new Map(); 
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
