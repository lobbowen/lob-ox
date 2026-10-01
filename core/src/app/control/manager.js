'use strict';

const { ManagedLifecycle } = require('./entry');

class LifecycleManager {
  constructor(opts) {
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.registrations = new Map();
  }

  register(lc) {
    if (!(lc instanceof ManagedLifecycle)) throw new Error('register 需要 ManagedLifecycle 实例');
    this.registrations.set(lc.id, lc);
    if (this.logger && this.logger.debug) this.logger.debug('[lifecycle] 注册 ' + lc.kind + ':' + lc.id);
    return lc;
  }

  unregister(id) {
    const lc = this.registrations.get(id);
    if (lc) { lc._monitoring = false; this.registrations.delete(id); }
  }

  get(id) { return this.registrations.get(id) || null; }

  all() { return [...this.registrations.values()]; }

  async start(id) {
    const lc = this.registrations.get(id);
    if (!lc) return { ok: false, error: '未注册模块: ' + id };
    if (lc.startable === false) return { ok: false, error: '模块不可启停（' + lc.kind + ':' + lc.id + '）' };
    if (id !== 'dsh') lc._monitoring = true;
    lc.wantRunning();
    const r = await lc.start();
    this._emit('lifecycle_started', { id: lc.id, kind: lc.kind, ok: r.ok, error: r.error });
    return { ok: r.ok !== false, error: r.error, already: r.already, ...lc.snapshot() };
  }

  async stop(id, reason) {
    const lc = this.registrations.get(id);
    if (!lc) return { ok: false, error: '未注册模块: ' + id };
    if (lc.startable === false) return { ok: false, error: '模块不可启停（' + lc.kind + ':' + lc.id + '）' };
    if (id !== 'dsh') lc._monitoring = false;
    const r = await lc.stop(reason || 'user-stop');
    this._emit('lifecycle_stopped', { id: lc.id, kind: lc.kind, ok: r.ok, reason });
    return { ok: r.ok !== false, error: r.error, already: r.already, ...lc.snapshot() };
  }

  async restart(id) {
    const lc = this.registrations.get(id);
    if (!lc) return { ok: false, error: '未注册模块: ' + id };
    if (lc.startable === false) return { ok: false, error: '模块不可启停（' + lc.kind + ':' + lc.id + '）' };
    const r = await lc.restart();
    return { ok: r.ok !== false, error: r.error, ...lc.snapshot() };
  }

  statusAll() {
    return this.all().map((l) => lc_status(l));
  }

  async stopAll(reason, opts) {
    const exclude = new Set((opts && opts.exclude) || []);
    for (const lc of this.all()) {
      if (exclude.has(lc.id)) continue;
      if (lc._monitoring || lc.desired === 'running') {
        lc._monitoring = false;
        try { await lc.stop(reason || 'guard-shutdown'); } catch {}
      }
    }
  }

  _emit(type, data) {
    if (this.events) { try { this.events.append(type, data); } catch {} }
  }
}

function lc_status(lc) {
  return lc.snapshot();
}

module.exports = { LifecycleManager };
