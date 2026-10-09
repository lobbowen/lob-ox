'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');
const { DESIRED, MANAGED_KINDS, kindMeta, registerKind: registerManagedKind, createEntry, normalizeOwnership } = require('./managed-object');

// 目录相位集合：'backoff' 已随 U-5 统一重启策略删除（全域只有一条：窗口内 N 次失败 ⇒ failed，无阶梯、无等待）。
const PHASES = ['stopped', 'installing', 'starting', 'running', 'draining', 'failed'];
// 老状态文件里可能残留已删除的登记相位 ⇒ 读取时归一到新集合（同 app/state/phase.js 的做法），不许读崩。
const LEGACY_PHASES = { backoff: 'failed', restarting: 'starting' };

const { runHeartbeat } = require('./heartbeat');

class ManagedRegistry {
  constructor(opts) {
    this.file = opts && opts.file;
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.ports = (opts && opts.ports) || null;
    this._objects = [];
    this._byId = new Map();
    this._adapters = {};
    this._loadedFromDisk = false;
    this._saveBlocked = false;
    if (this.file) {
      try { this._loadedFromDisk = fs.existsSync(this.file); } catch { this._loadedFromDisk = false; }
      this._load();
    }
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (this._loadedFromDisk) {
        this._log('warn', 'managed-objects 读/解析失败，按损坏保全处理: ' + ((e && e.message) || e));
        this._loadedFromDisk = false;
        let bak = null;
        try {
          bak = this.file + '.bad-' + Date.now();
          fs.renameSync(this.file, bak);
        } catch (e2) {
          this._saveBlocked = true;
          this._log('warn', 'managed-objects 损坏备份失败，持久化已禁用: ' + ((e2 && e2.message) || e2));
        }
        this._event('managed_registry_corrupt', { backup: bak, error: (e && e.message) || String(e) });
      }
      return;
    }
    const arr = (raw && Array.isArray(raw.objects)) ? raw.objects : [];
    for (const o of arr) {
      try {
        if (!o || !kindMeta(o.kind)) continue;
        const e = createEntry({ kind: o.kind, id: o.id, name: o.name, desired: o.desired, ownership: o.ownership });
        if (PHASES.includes(LEGACY_PHASES[o.phase] || o.phase)) e.phase = LEGACY_PHASES[o.phase] || o.phase;
        if (Number.isInteger(o.restartCount) && o.restartCount >= 0) e.restartCount = o.restartCount;
        if (o.startupFailWindowStart === null || typeof o.startupFailWindowStart === 'number') e.startupFailWindowStart = o.startupFailWindowStart;
        if (Number.isInteger(o.startupFailCount) && o.startupFailCount >= 0) e.startupFailCount = o.startupFailCount;
        if (typeof o.startedAt === 'string') e.startedAt = o.startedAt;
        e.lastTransitionAt = null;
        this._index(e);
      } catch (err) {
        this._log('warn', 'managed-objects 条目损坏已跳过(' + ((o && o.kind) || '?') + ':' + ((o && o.id) || '?') + '): ' + ((err && err.message) || err));
      }
    }
  }

  _save() {
    if (!this.file) return;
    if (this._saveBlocked) return;
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        schema: 'managed-objects@1',
        objects: this._objects.map((o) => Object.assign({
          kind: o.kind, id: o.id, name: o.name,
          desired: o.desired,
          ownership: o.ownership,
          phase: o.phase,
          restartCount: Number.isInteger(o.restartCount) ? o.restartCount : 0,
          startupFailWindowStart: o.startupFailWindowStart || null,
          startupFailCount: Number.isInteger(o.startupFailCount) ? o.startupFailCount : 0,
          startedAt: o.startedAt, createdAt: o.createdAt, updatedAt: o.updatedAt,
        })),
      }, null, 2);
      writeAtomic(this.file, body, { mode: 0o600 });
    } catch (e) { this._log('warn', 'managed-objects 持久化失败: ' + (e && e.message)); }
  }

  persistCrashState() {
    if (this._crashSaveTimer) return;
    this._crashSaveTimer = setTimeout(() => {
      this._crashSaveTimer = null;
      this._save();
    }, 50);
    if (this._crashSaveTimer.unref) this._crashSaveTimer.unref();
  }

  _log(lv, msg) {
    if (this.logger && this.logger[lv]) this.logger[lv](msg);
  }
  _event(type, data) {
    if (this.events && this.events.append) { try { this.events.append(type, data || {}); } catch {} }
  }

  _index(e) { this._byId.set(e.id, e); this._objects.push(e); }
  _drop(e) {
    this._byId.delete(e.id);
    const i = this._objects.indexOf(e);
    if (i >= 0) this._objects.splice(i, 1);
  }

  // 自定义 kind 扩展点：零调用但刻意保留（见 managed-object.js 的说明）——
  // 它是「新增受管对象类型」的唯一入口，删除等于永久关闭扩展能力。
  registerKind(kind, meta) {
    registerManagedKind(kind, meta);
    return this;
  }

  registerAdapter(kind, adapter) {
    if (!kindMeta(kind)) throw new Error('未知类型，先 registerKind: ' + kind);
    this._adapters[kind] = adapter || {};
    return this;
  }
  adapter(kind) { return this._adapters[kind] || null; }

  register(spec) {
    const e = createEntry(spec);
    if (this._byId.has(e.id)) throw new Error('重复注册（id 已存在）: ' + e.id);
    this._index(e);
    this._syncPortsOwner(e, true);
    this._save();
    this._event('managed_object_registered', { kind: e.kind, id: e.id, name: e.name });
    return e;
  }

  update(id, patch) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '未注册: ' + id };
    const p = patch || {};
    if (p.desired !== undefined) {
      if (!DESIRED.includes(p.desired)) return { ok: false, error: '非法 desired: ' + p.desired };
      e.desired = p.desired;
    }
    if (p.name !== undefined) e.name = String(p.name || e.id);
    if (p.ownership !== undefined) {
      const old = e.ownership.ports;
      e.ownership = normalizeOwnership(Object.assign({}, e.ownership, p.ownership));
      this._syncPortsOwner(e, true);
      for (const op of old) { if (!e.ownership.ports.some((np) => np.port === op.port)) this._releasePort(op.port, e.id); }
    }
    e.updatedAt = new Date().toISOString();
    this._save();
    this._event('managed_object_updated', { kind: e.kind, id: e.id });
    return { ok: true, object: e };
  }

  unregister(id, opts) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '未注册: ' + id };
    const o = opts || {};
    e._nextTickAt = null;
    for (const op of e.ownership.ports) this._releasePort(op.port, e.id);
    if (o.onBeforeRemove) { try { o.onBeforeRemove(e); } catch (err) { this._log('warn', 'onBeforeRemove(' + e.id + '): ' + (err && err.message)); } }
    this._drop(e);
    this._save();
    this._event('managed_object_removed', { kind: e.kind, id: e.id });
    return { ok: true };
  }

  _releasePort(port, ownerId) {
    if (!this.ports || typeof this.ports.release !== 'function') return;
    try { this.ports.release(port, ownerId); } catch (err) {
      this._log('warn', 'releasePort(' + port + '/' + ownerId + '): ' + (err && err.message));
    }
  }
  _syncPortsOwner(e, ensure) {
    if (!this.ports || typeof this.ports.allocateMark !== 'function') return;
    for (const op of e.ownership.ports) {
      try {
        if (ensure && !this.ports.isRegistered(op.port)) this.ports.allocateMark(op.port, 'managed:' + e.id, e.id);
      } catch {}
    }
  }

  list() { return this._objects.slice(); }
  get(id) { return this._byId.get(id) || null; }
  byKind(kind) { return this._objects.filter((o) => o.kind === kind); }
  count() { return this._objects.length; }

  heartbeat(intervalMs) { return runHeartbeat(this, intervalMs); }

  applyObservation(id, obs) {
    const e = this.get(id);
    if (!e) return null;
    e.lastObserved = {
      ok: !!(obs && obs.ok),
      error: (obs && obs.error) || null,
      at: new Date().toISOString(),
    };
    return e;
  }

  setRestartCount(id, n) {
    const e = this.get(id);
    if (!e) return null;
    const v = (typeof n === 'number' && n >= 0) ? Math.floor(n) : 0;
    if (e.restartCount !== v) {
      e.restartCount = v;
      this._event('managed_object_restart_count', { kind: e.kind, id: e.id, count: v });
      this._save();
    }
    return e;
  }

  setPhase(id, p) {
    const e = this.get(id);
    if (!e) return null;
    if (!PHASES.includes(p)) return e;
    if (e.phase !== p) {
      e.phase = p;
      e.lastTransitionAt = new Date().toISOString();
      this._event('managed_object_phase', { kind: e.kind, id: e.id, phase: p });
      this._save();
    }
    return e;
  }
}

module.exports = { ManagedRegistry, createEntry, PHASES, DESIRED, MANAGED_KINDS, kindMeta, normalizeOwnership };
