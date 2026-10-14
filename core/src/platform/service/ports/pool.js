'use strict';

const fs = require('node:fs');
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
    // R6 / D.8-P0-4：兄弟账本联合避让。
    // guard 与 router-daemon 是两个进程、两个文件（ports.json 与 ports-router.json）、
    // 一套重叠的 managed 池（20000-23999）。alloc.lock 只保护单文件互斥，不保护池的
    // 跨文件重叠，于是双方可各自选中同一端口。readAll 早已把 sibling 文件并入读端视图，
    // 但写端 _allocFreeCore / _tryClaim 只查本方 _records——「看得见别人但不避开别人」。
    // 修法：构造时登记 sibling 文件，分配与判重时把它们的已占用端口一并视为不可用。
    // 缓存按 mtime 失效，避免每次分配都全量读盘。
    this._foreign = [];
    this._foreignStamp = new Map();
    if (Array.isArray(opts && opts.siblingFiles)) {
      for (const f of opts.siblingFiles) {
        if (typeof f === 'string' && f && f !== this._file) this._foreign.push(f);
      }
    }
    this._foreignCache = new Map();
    this._load();
  }

  // 联合避让集合：本方记录 + 所有 sibling 文件的记录（按 port 去重）。
  // 带 mtime 缓存：sibling 未变时不重复读盘。
  _foreignPorts() {
    const out = new Map();
    for (const r of this._records.values()) out.set(r.port, r);
    for (const f of this._foreign) {
      // 文件变更指纹统一走 util/lease.stampOf（此前这里内联了第三遍同一表达式）。
      const stamp = require('../../util/lease').stampOf(f) || '0';
      if (this._foreignStamp.get(f) === stamp && this._foreignCache.has(f)) {
        for (const [port, rec] of this._foreignCache.get(f)) if (!out.has(port)) out.set(port, rec);
        continue;
      }
      const recs = store.loadRecords(f);
      const m = new Map();
      for (const r of recs) m.set(r.port, r);
      this._foreignStamp.set(f, stamp);
      this._foreignCache.set(f, m);
      for (const [port, rec] of m) if (!out.has(port)) out.set(port, rec);
    }
    return out;
  }

  configurePools(pools) {
    if (pools && typeof pools === 'object') this._pools = Object.assign({}, core.DEFAULT_POOLS, pools);
    return this._pools;
  }

  registerSegment(role, pool) { core.registerSegment(role, pool); return this; }

  rangeOf(segment) { return core.rangeOf(this._pools, segment); }

  _anchorOffset(segment) { return core.anchorOffset(this._pools, segment); }

  configureFile(file, opts) {
    if (typeof file !== 'string' || !file) return;
    const o = opts || {};
    this._file = file;
    this._records = new Map();
    this._allocLock = false;
    // R6：siblingFiles 显式声明兄弟账本。不传则清空（保持旧语义）。
    if (Array.isArray(o.siblingFiles)) {
      this._foreign = o.siblingFiles.filter((f) => typeof f === 'string' && f && f !== file);
    } else {
      this._foreign = this._foreign.filter((f) => f !== file);
    }
    this._foreignStamp.clear();
    this._foreignCache.clear();
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

  // R6 / D.8-P1-9：五个 mutator（register / registerUser / unregister / release /
  // allocateMark）原先都只 _syncFromDisk 后直接读改写 _save，全程不持锁——而
  // claimSlot 与 allocate 是持锁的。同一份账本上两类写入的互斥强度不同，
  // 于是 alloc 持锁期间一个 register 可中途插入并覆盖对方刚写的记录。
  // 修法：所有 mutator 统一走 _mutate，与 alloc 用同一把 _allocLock。
  // 进程内互斥由这把锁保证；跨进程互斥由 alloc 的 .alloc.lock 保证（mutator 的
  // 写盘本身是 writeAtomic 原子替换，不会写坏文件，丢的只是「对方的记录」）。
  _mutate(fn) {
    if (this._allocLock) { return fn(); }   // 已持锁（alloc 路径内联调用）不重入
    let waited = 0;
    for (;;) {
      if (require('../../util/lease').acquireSync(this, '_allocLock')) break;
      await0();
      waited += 10;
      if (waited >= 3000) throw new Error('ports: 进程内写锁等待超时（3s），拒绝在无锁状态下写账本');
    }
    try { return fn(); } finally { this._allocLock = false; }
  }

  migrateByOwnerPrefix(oldFile, newFile, prefixes) {
    return migrate.migrateByOwnerPrefix(oldFile, newFile, prefixes);
  }

  register(role, port) {
    return this._mutate(() => this._registerLocked(role, port));
  }

  _registerLocked(role, port) {
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
    // 整段都在锁内：先删旧同 role 记录再 register。若拆成两步，中间的删除会被
    // 并发的 register 覆盖。
    return this._mutate(() => {
      this._syncFromDisk();
      const p = Number(port);
      for (const [existing, r] of [...this._records]) {
        if (r.role === role && existing !== p) this._records.delete(existing);
      }
      return this._registerLocked(role, p);
    });
  }

  registerUser(port, owner) {
    return this._mutate(() => this._registerUserLocked(port, owner));
  }

  _registerUserLocked(port, owner) {
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
    return this._mutate(() => this._unregisterLocked(owner));
  }

  _unregisterLocked(owner) {
    this._syncFromDisk();
    let removed = false;
    for (const [p, r] of this._records) {
      if (r.owner === owner) { this._records.delete(p); removed = true; }
    }
    if (removed) this._save();
  }

  release(port, ownerId) {
    return this._mutate(() => this._releaseLocked(port, ownerId));
  }

  _releaseLocked(port, ownerId) {
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
    return this._mutate(() => this._allocateMarkLocked(port, role, owner));
  }

  _allocateMarkLocked(port, role, owner) {
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
