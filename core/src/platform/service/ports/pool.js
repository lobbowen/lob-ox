'use strict';

// 系统级统一端口注册表（PortRegistry）：全部端口登记为唯一来源的记录 { port, role, owner, createdAt }，
// 持久化到 ports.json（0600），守卫重启后绑定全量恢复、不重复分配；owner 归属，删除对象即释放端口。

const path = require('node:path');
const stateRoot = require('../../service/state-root');
const core = require('./core');
const store = require('./store');
const migrate = require('./migrate');
const probe = require('./probe');
const { PortAllocator } = require('./alloc');

class PortRegistry {
  /** @param {object} [opts] { file, pools } — file 默认 <状态根>/supervisor/ports.json。 */
  constructor(opts) {
    this._file = (opts && opts.file) || path.join(stateRoot.supervisorDir(), 'ports.json');
    this._records = new Map();
    this._allocLock = false;     // 分配互斥：探测(await)窗口内并发调用必须串行
    this._pools = Object.assign({}, core.DEFAULT_POOLS, (opts && opts.pools) || {});
    this._alloc = new PortAllocator(this);
    this._load();
  }

  /** 设置/覆盖物理池定义（config 注入）。 */
  configurePools(pools) {
    if (pools && typeof pools === 'object') this._pools = Object.assign({}, core.DEFAULT_POOLS, pools);
    return this._pools;
  }

  /** 实例侧注册接口（委托 core 模块级函数）；段名/池名是域知识，不在本平台模块硬编码（DS-G4）。 */
  registerSegment(role, pool) { core.registerSegment(role, pool); return this; }

  /** 逻辑段到池定义（未注册段名回退 managed 池）。 */
  rangeOf(segment) { return core.rangeOf(this._pools, segment); }

  _anchorOffset(segment) { return core.anchorOffset(this._pools, segment); }

  /** 重设持久化文件并重新加载；旧内存记录废弃（不写回旧文件）。 */
  configureFile(file) {
    if (typeof file !== 'string' || !file) return;
    this._file = file;
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  /* 持久化（委托 store） */
  _load() {
    this._records = new Map();
    for (const r of store.loadRecords(this._file)) this._records.set(r.port, r);
    this._diskStamp = store.fileStamp(this._file);
  }

  /** 跨进程对时（B2-5）：ports.json 是多进程（守卫 + lan-daemon）共享事实源，各方全量
   *  read-modify-write，陈旧内存快照会在 _save 时把他人新增整段覆盖丢失、或让分配器抢注
   *  他进程已登记的端口。指纹（mtime+size）变化即重载——所有写口与冲突判读口的入口。
   *  不动 _allocLock（复位会击穿本进程在飞分配的互斥）。 */
  _syncFromDisk() {
    if (store.fileStamp(this._file) !== this._diskStamp) this._load();
  }

  /** 重新从文件加载（读路径先 reload，以权威文件为准）。 */
  reload() {
    this._records = new Map();
    this._allocLock = false;
    this._load();
  }

  _save() { store.saveRecords(this._file, [...this._records.values()]); this._diskStamp = store.fileStamp(this._file); }

  /** 通用记录迁移：owner 命中任一前缀的记录 oldFile 到 newFile，并从旧文件清除。 */
  migrateByOwnerPrefix(oldFile, newFile, prefixes) {
    return migrate.migrateByOwnerPrefix(oldFile, newFile, prefixes);
  }

  /* 登记（固定 / 用户 / 动态） */
  /** 登记固定端口；同端口已被其它固定角色占用则报错；user/动态记录由固定权威覆盖。 */
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

  /** 登记固定端口，并保证该 role 在全表唯一（先清除同 role 的其它端口记录再登记）。
   *  登记表以端口号为键，避让/重绑后新端口是**追加**记录；只 release 旧端口不足以立住不变式
   *  （该调用在内核侧被 catch{} 包住且忽略返回值），残留两条同 role 记录时任何「按 role 取号」
   *  的读法（本表 get、桌面壳读 ports.json）都可能拿到一个没人监听的端口。
   *  @returns {number} port */
  registerSole(role, port) {
    const p = Number(port);
    for (const [existing, r] of [...this._records]) {
      if (r.role === role && existing !== p) this._records.delete(existing);
    }
    return this.register(role, p);
  }

  /** 登记用户配置端口（实例内部端口等）；冲突（固定/保留池/已占）抛错。 */
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

  /** 按 owner 释放端口（对象删除/关闭时调用）。 */
  unregister(owner) {
    this._syncFromDisk();
    let removed = false;
    for (const [p, r] of this._records) {
      if (r.owner === owner) { this._records.delete(p); removed = true; }
    }
    if (removed) this._save();
  }

  /** 释放端口：不传 ownerId 按端口号；传了则仅当登记 owner 匹配才释放。空值检查必须先于 owner 比较。
   *  @returns {boolean} 是否真的释放了一条记录 */
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

  /* 查询 */
  /** 按 role 取端口（固定端口）。同 role 有多条（老版本避让留下的残留记录）时取**最新登记**：
   *  桌面壳读 ports.json 用的是同一判据，两侧不许对「哪个端口是当前的」给出不同答案。 */
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

  /** 端口是否被占用：已登记 或 本机实际监听；excludeOwner 仅豁免 registry 登记。
   *  监听探测为双栈回环（127.0.0.1 并 ::1），不漏 IPv6-only 监听者。 */
  async isTaken(port, excludeOwner) {
    const rec = this._records.get(Number(port));
    if (rec && (!excludeOwner || rec.owner !== excludeOwner)) return true;
    return probe.loopbackListening(port);
  }

  /** 全部端口清单（按端口升序）。 */
  list() {
    this._syncFromDisk();
    return [...this._records.values()].sort((a, b) => a.port - b.port);
  }

  /** 只读聚合：本注册表 + 同目录下其它注册表文件（去重，本表优先）。
   *  @param {string[]} extraFiles 相对本注册表目录的文件名 */
  readAll(extraFiles) {
    const byPort = new Map();
    const adopt = (r) => { if (r && !byPort.has(r.port)) byPort.set(r.port, r); };
    for (const r of this.list()) adopt(r);
    for (const r of store.extraRecords(this._file, extraFiles)) adopt(r);
    return [...byPort.values()];
  }

  /* 确定性槽位仲裁 / 动态分配（委托 PortAllocator） */
  /** 统一绑定持久 + 确定性分配 + 孤儿回收，池满返回显式 conflict。 */
  claimSlot(rangeKey, owner, opts) { return this._alloc.claimSlot(rangeKey, owner, opts); }

  /** 指定逻辑段分配空闲端口并登记（owner 绑定）；池满返回 null。 */
  allocate(rangeKey, owner, opts) { return this._alloc.allocate(rangeKey, owner, opts); }

  /** 显式登记已分配端口（复用持久化端口时调用）。 */
  allocateMark(port, role, owner) {
    this._syncFromDisk();
    const p = Number(port);
    if (!this._records.has(p)) {
      this._records.set(p, { port: p, role: role || 'dynamic', owner: owner || 'dynamic', createdAt: Date.now() });
      this._save();
    }
  }

  /* 容量 */
  /** 池容量视图：每池 { base, size, used, free, utilization }。 */
  capacity() { return core.capacityOf(this._pools, this._records); }

  /** 逻辑段当前可用量。 */
  available(segment) { return core.availableOf(this._pools, this._records, segment); }

  /** 逻辑段是否已满。 */
  isFull(segment) { return this.available(segment) <= 0; }

  /** 全部端口快照（固定/用户/分配）。 */
  snapshotAll() { return core.snapshotOf(this._records); }
}

module.exports = { PortRegistry };
