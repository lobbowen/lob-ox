'use strict';

const path = require('node:path');
const stateRoot = require('../../service/state-root');
const core = require('./core');
const store = require('./store');
const migrate = require('./migrate');
const probe = require('./probe');
const { PortAllocator } = require('./alloc');

class PortRegistry {
  constructor(opts) {
    this._file = (opts && opts.file) || path.join(stateRoot.supervisorDir(), 'ports.json');
    this._records = new Map();
    this._allocLock = false;
    this._pools = Object.assign({}, core.DEFAULT_POOLS, (opts && opts.pools) || {});
    this._alloc = new PortAllocator(this);
    this._load();
  }

  configurePools(pools) {
    if (pools && typeof pools === 'object') this._pools = Object.assign({}, core.DEFAULT_POOLS, pools);
    return this._pools;
  }

  registerSegment(role, pool) { core.registerSegment(role, pool); return this; }

  rangeOf(segment) { return core.rangeOf(this._pools, segment); }

  _anchorOffset(segment) { return core.anchorOffset(this._pools, segment); }

  configureFile(file) {
    if (typeof file !== 'string' || !file) return;
    this._file = file;
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  _load() {
    this._records = new Map();
    for (const r of store.loadRecords(this._file)) this._records.set(r.port, r);
    this._diskStamp = store.fileStamp(this._file);
  }

  _syncFromDisk() {
    if (store.fileStamp(this._file) !== this._diskStamp) this._load();
  }

  reload() {
    
    
    
    this._records = new Map();
    this._load();
  }

  _save() { store.saveRecords(this._file, [...this._records.values()]); this._diskStamp = store.fileStamp(this._file); }

  migrateByOwnerPrefix(oldFile, newFile, prefixes) {
    return migrate.migrateByOwnerPrefix(oldFile, newFile, prefixes);
  }

  register(role, port) {
    this._syncFromDisk();
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.register: 非法端口 ' + port);
    const existing = this._records.get(p);
    if (existing) {
      const existingFixed = String(existing.owner || '').startsWith('system:');
      if (existingFixed && existing.role !== role) throw new Error('端口 ' + p + ' 已被 [' + existing.role + '] 占用，无法登记为 [' + role + ']');
      if (existing.owner && !existingFixed) this._records.delete(p);
    }
    this._records.set(p, { port: p, role, owner: 'system:' + role, createdAt: Date.now() });
    this._save();
    return p;
  }

  registerSole(role, port) {
    const p = Number(port);
    for (const [existing, r] of [...this._records]) {
      if (r.role === role && existing !== p) this._records.delete(existing);
    }
    return this.register(role, p);
  }

  registerUser(port, owner) {
    this._syncFromDisk();
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error('ports.registerUser: 非法端口 ' + port);
    if (this._records.has(p)) throw new Error('端口 ' + p + ' 已被 [' + this._records.get(p).role + '] 占用');
    const reserved = core.reservedPoolOf(this._pools, p);
    if (reserved) throw new Error('端口 ' + p + ' 位于动态保留池 [' + reserved + ']，实例端口不可占用');
    this._records.set(p, { port: p, role: 'user', owner: owner || 'user', createdAt: Date.now() });
    this._save();
    return p;
  }

  unregister(owner) {
    this._syncFromDisk();
    let removed = false;
    for (const [p, r] of this._records) {
      if (r.owner === owner) { this._records.delete(p); removed = true; }
    }
    if (removed) this._save();
  }

  release(port, ownerId) {
    this._syncFromDisk();
    const p = Number(port);
    const rec = this._records.get(p);
    if (!rec) return false;
    if (ownerId !== undefined && ownerId !== null && rec.owner !== ownerId) return false;
    this._records.delete(p);
    this._save();
    return true;
  }

  get(role) {
    this._syncFromDisk();
    let best = null;
    for (const r of this._records.values()) {
      if (r.role !== role) continue;
      if (!best || (r.createdAt || 0) >= (best.createdAt || 0)) best = r;
    }
    return best ? best.port : null;
  }

  isRegistered(port) { this._syncFromDisk(); return this._records.has(Number(port)); }

  recordOf(port) { this._syncFromDisk(); return this._records.get(Number(port)) || null; }

  byOwner(owner) {
    this._syncFromDisk();
    for (const r of this._records.values()) if (r.owner === owner) return r.port;
    return null;
  }

  async isTaken(port, excludeOwner) {
    const rec = this._records.get(Number(port));
    if (rec && (!excludeOwner || rec.owner !== excludeOwner)) return true;
    return probe.loopbackListening(port);
  }

  list() {
    this._syncFromDisk();
    return [...this._records.values()].sort((a, b) => a.port - b.port);
  }

  readAll(extraFiles) {
    const byPort = new Map();
    const adopt = (r) => { if (r && !byPort.has(r.port)) byPort.set(r.port, r); };
    for (const r of this.list()) adopt(r);
    for (const r of store.extraRecords(this._file, extraFiles)) adopt(r);
    return [...byPort.values()];
  }

  claimSlot(rangeKey, owner, opts) { return this._alloc.claimSlot(rangeKey, owner, opts); }

  allocate(rangeKey, owner, opts) { return this._alloc.allocate(rangeKey, owner, opts); }

  allocateMark(port, role, owner) {
    this._syncFromDisk();
    const p = Number(port);
    if (!this._records.has(p)) {
      this._records.set(p, { port: p, role: role || 'dynamic', owner: owner || 'dynamic', createdAt: Date.now() });
      this._save();
    }
  }

  capacity() { return core.capacityOf(this._pools, this._records); }

  available(segment) { return core.availableOf(this._pools, this._records, segment); }

  isFull(segment) { return this.available(segment) <= 0; }

  snapshotAll() { return core.snapshotOf(this._records); }
}

module.exports = { PortRegistry };
