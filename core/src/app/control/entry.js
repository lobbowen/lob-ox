'use strict';

const { PHASES } = require('./registry');

class ManagedLifecycle {
  constructor(opts) {
    this.id = opts.id || ('lc-' + Math.random().toString(36).slice(2, 8));
    this.kind = opts.kind || 'module';
    this.name = opts.name || this.id;
    this.startable = opts.startable !== false;
    this.guardable = opts.guardable !== false;
    this.logger = opts.logger || null;
    this.events = opts.events || null;
    this._start = opts.start || null;
    this._stop = opts.stop || null;
    this._restart = opts.restart || null;
    this._status = opts.status || null;
    this.phase = 'stopped';
    this.desired = 'stopped';
    this.healthy = false;
    this.lastProbeAt = null;
    this.lastTransitionAt = null;
    this.error = null;
    this.startedAt = null;
    this.guardian = this.guardable && opts.guardian === true;
    this._monitoring = false;
  }

  snapshot() {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      phase: this.phase,
      desired: this.desired,
      healthy: this.healthy,
      startedAt: this.startedAt,
      lastProbeAt: this.lastProbeAt,
      lastTransitionAt: this.lastTransitionAt,
      error: this.error,
      guardian: this.guardian === true,
      startable: this.startable,
      guardable: this.guardable,
      monitoring: this._monitoring,
      detail: this._status ? (this._status() || null) : null,
    };
  }

  _setPhase(p) {
    if (!PHASES.includes(p)) return;
    if (this.phase !== p) {
      this.phase = p;
      this.lastTransitionAt = new Date().toISOString();
    }
  }

  wantRunning() {
    this.desired = 'running';
    this.error = null;
  }

  wantStopped() {
    this.desired = 'stopped';
  }

  async start() {
    if (this.phase === 'running' || this.phase === 'starting') return { ok: true, already: true };
    this.error = null;
    this._setPhase('starting');
    try {
      const r = this._start ? await this._start() : { ok: true };
      if (r && r.ok === false) {
        this.error = r.error || 'start 返回 ok:false（未提供 error）';
        this._setPhase('stopped');
        this.healthy = false;
        this.desired = 'stopped';
        if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' start 被拒: ' + this.error);
        return { ok: false, error: this.error, ...this.snapshot() };
      }
      this.startedAt = this.startedAt || new Date().toISOString();
      this.desired = 'running';
      this._setPhase('running');
      this.healthy = true;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase('stopped');
      this.desired = 'stopped';
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' start 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  async stop(reason) {
    if (this.phase === 'stopped') {
      this.desired = 'stopped';
      return { ok: true, already: true };
    }
    const prevPhase = this.phase;
    this._setPhase('draining');
    try {
      const r = this._stop ? await this._stop(reason) : { ok: true };
      if (r && r.ok === false) {
        this.error = r.error || 'stop 返回 ok:false（未提供 error）';
        this._setPhase(prevPhase);
        if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' stop 被拒: ' + this.error);
        return { ok: false, error: this.error, ...this.snapshot() };
      }
      this.desired = 'stopped';
      this._setPhase('stopped');
      this.healthy = false;
      return r || { ok: true };
    } catch (e) {
      this.error = (e && e.message) || String(e);
      this._setPhase(prevPhase);
      if (this.logger && this.logger.warn) this.logger.warn('[lifecycle] ' + this.id + ' stop 失败: ' + this.error);
      return { ok: false, error: this.error };
    }
  }

  async restart() {
    if (this._restart) {
      const r = await this._restart();
      if (r && r.ok === false) return { ...this.snapshot(), ok: false, error: r.error };
      return { ...this.snapshot(), ok: r && r.ok !== false };
    }
    const wasDesired = this.desired;
    const rs = await this.stop('restart');
    if (rs && rs.ok === false) {
      return { ...this.snapshot(), ok: false, error: 'restart: 停止失败 — ' + (rs.error || '未知') };
    }
    if (wasDesired === 'running') {
      const rt = await this.start();
      if (rt && rt.ok === false) {
        return { ...this.snapshot(), ok: false, error: 'restart: 启动失败 — ' + (rt.error || '未知') };
      }
    }
    return { ...this.snapshot(), ok: true };
  }
}

module.exports = { ManagedLifecycle, PHASES };
