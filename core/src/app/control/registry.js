'use strict';

// 管家注册机（ManagedRegistry）——守卫直接负责的受管对象声明目录：身份、应然
// （desired，业务申报、持久；guardian 不入册——权威在域记录，B2-2）、所有权（端口/root/unit/daemon）、类型适配器挂接。
// SSOT 与铁律（实然绝不写回目录；phase 由调谐循环驱动、业务不得直改；路径由 root 派生；
// 域自治对象不入簿）在契约 GUARD-DOMAIN-MODEL，两份冲突以契约为准。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');
const { DESIRED, MANAGED_KINDS, kindMeta, registerKind: registerManagedKind, createEntry, normalizeOwnership } = require('./managed-object');

/** 进程生命周期唯一词表。'installing' 是对应安装任务的操作态；升级/卸载态在 TaskRegistry，不在 phase。 */
const PHASES = ['stopped', 'installing', 'starting', 'running', 'draining', 'backoff', 'failed', 'restarting'];

const { runHeartbeat } = require('./heartbeat');

class ManagedRegistry {
  /**
   * @param {object} opts { file?: string(managed-objects.json), logger?, events?, ports? }
   */
  constructor(opts) {
    this.file = opts && opts.file;
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.ports = (opts && opts.ports) || null; // 统一端口注册表（owner 释放联动；可选）
    this._objects = [];           // 内存目录（顺序 = 注册序）
    this._byId = new Map();
    this._adapters = {};          // kind -> { observe, apply }（类型模块挂接；不持久化）
    // 状态单源判定：true = 目录已有权威 desired，state.json 不回灌；false = 首启/老库迁移，
    // 允许 state.json 的 desired 作一次性种子。必须记录「构造前是否存在」——构造函数随后会
    // 创建文件，事后再查判定失真。
    this._loadedFromDisk = false;
    this._saveBlocked = false; // 损坏且连改名保全都失败时置真，本进程禁绝对目录文件的覆盖写
    if (this.file) {
      try { this._loadedFromDisk = fs.existsSync(this.file); } catch { this._loadedFromDisk = false; }
      this._load();
    }
  }

  /*  持久化（应然+所有权；实然与适配器不入册）  */
  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      // 既有文件损坏 != 首启空目录：当空目录继续会让任一 upsert 用派生内容覆盖原文件，
      // desired/崩溃计数永久丢失。故改名 .bad-<ts> 保全原始字节，并以「未加载」态启动
      // （允许 state.json 种子回灌）。
      if (this._loadedFromDisk) {
        this._log('warn', 'managed-objects 读/解析失败，按损坏保全处理: ' + ((e && e.message) || e));
        this._loadedFromDisk = false;
        let bak = null;
        try {
          bak = this.file + '.bad-' + Date.now();
          fs.renameSync(this.file, bak);
        } catch (e2) {
          this._saveBlocked = true; // 连改名保全都失败 -> 本进程禁对该路径覆盖写
          this._log('warn', 'managed-objects 损坏备份失败，持久化已禁用: ' + ((e2 && e2.message) || e2));
        }
        this._event('managed_registry_corrupt', { backup: bak, error: (e && e.message) || String(e) });
      }
      return;
    }
    const arr = (raw && Array.isArray(raw.objects)) ? raw.objects : [];
    for (const o of arr) {
      // 逐条容错：单条坏 entry 不得中断整份加载，否则其后合法条目全部静默丢失
      try {
        if (!o || !kindMeta(o.kind)) continue; // 未知类型/损坏条目跳过，不阻断启动
        // guardian 不再入册（B2-2）：老库残留键经 createEntry 重建自然丢弃，无需迁移脚本。
        const e = createEntry({ kind: o.kind, id: o.id, name: o.name, desired: o.desired, ownership: o.ownership });
        if (PHASES.includes(o.phase)) e.phase = o.phase;
        if (Number.isInteger(o.backoffLevel)) e.backoffLevel = o.backoffLevel;
        if (typeof o.backoffUntil === 'number' && o.backoffUntil > Date.now()) e.backoffUntil = o.backoffUntil;
        // 崩溃窗/重启计数以目录为唯一副本（main 崩溃保护跨守卫重启保持），state.json 不再双写。
        if (Number.isInteger(o.restartCount) && o.restartCount >= 0) e.restartCount = o.restartCount;
        if (o.crashWindowStart === null || typeof o.crashWindowStart === 'number') e.crashWindowStart = o.crashWindowStart;
        if (Number.isInteger(o.crashWindowRestarts) && o.crashWindowRestarts >= 0) e.crashWindowRestarts = o.crashWindowRestarts;
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
    if (this._saveBlocked) return; // 原字节未被保全前绝不覆盖（fail-closed）
    try {
      const dir = path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        schema: 'managed-objects@1',
        objects: this._objects.map((o) => Object.assign({
          kind: o.kind, id: o.id, name: o.name,
          // desired 两域共用（语义不同，见 createEntry）；guardian 不落盘（B2-2，权威在域记录）。
          desired: o.desired,
          ownership: o.ownership,
          phase: o.phase, backoffLevel: o.backoffLevel,
          backoffUntil: (o.backoffUntil && o.backoffUntil > Date.now()) ? o.backoffUntil : null,
          restartCount: Number.isInteger(o.restartCount) ? o.restartCount : 0,
          crashWindowStart: o.crashWindowStart || null,
          crashWindowRestarts: Number.isInteger(o.crashWindowRestarts) ? o.crashWindowRestarts : 0,
          startedAt: o.startedAt, createdAt: o.createdAt, updatedAt: o.updatedAt,
        })),
      }, null, 2);
      writeAtomic(this.file, body, { mode: 0o600 });
    } catch (e) { this._log('warn', 'managed-objects 持久化失败: ' + (e && e.message)); }
  }

  /** 崩溃/退避字段变化的持久化入口：防抖 50ms 合并同拍多次变更避免写放大；
   *  由 supervisor._persistCrashField 在字段变更后调用。 */
  persistCrashState() {
    if (this._crashSaveTimer) return; // 已排期，合并
    this._crashSaveTimer = setTimeout(() => {
      this._crashSaveTimer = null;
      this._save();
    }, 50);
    if (this._crashSaveTimer.unref) this._crashSaveTimer.unref(); // 不阻塞进程退出
  }

  _log(lv, msg) {
    if (this.logger && this.logger[lv]) this.logger[lv](msg);
  }
  _event(type, data) {
    if (this.events && this.events.append) { try { this.events.append(type, data || {}); } catch {} }
  }

  /*  目录操作  */
  _index(e) { this._byId.set(e.id, e); this._objects.push(e); }
  _drop(e) {
    this._byId.delete(e.id);
    const i = this._objects.indexOf(e);
    if (i >= 0) this._objects.splice(i, 1);
  }

  /** 注册新类型能力（显式声明，非通用 CRD；实现与判据见 managed-object.js）。 */
  registerKind(kind, meta) {
    registerManagedKind(kind, meta);
    return this;
  }

  /** 类型模块挂接适配器（observe/apply 实现留在类型层）。 */
  registerAdapter(kind, adapter) {
    if (!kindMeta(kind)) throw new Error('未知类型，先 registerKind: ' + kind);
    this._adapters[kind] = adapter || {};
    return this;
  }
  adapter(kind) { return this._adapters[kind] || null; }

  /** 业务创建对象时申报入册。 */
  register(spec) {
    const e = createEntry(spec);
    if (this._byId.has(e.id)) throw new Error('重复注册（id 已存在）: ' + e.id);
    this._index(e);
    this._syncPortsOwner(e, true);
    this._save();
    this._event('managed_object_registered', { kind: e.kind, id: e.id, name: e.name });
    return e;
  }

  /** 对象变更申报（desired/ownership/name）。guardian 不接受申报（B2-2）：createEntry 永不
   *  物化该键，patch 里带 guardian 一律忽略，老库残留由 load 重建时清理。 */
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
      // 合并而非整体替换：这是部分补丁接口，只带 ports 的调用方不应把
      // rootPath/unit/daemonScript/processMode 静默清成 null。
      e.ownership = normalizeOwnership(Object.assign({}, e.ownership, p.ownership));
      this._syncPortsOwner(e, true);
      for (const op of old) { if (!e.ownership.ports.some((np) => np.port === op.port)) this._releasePort(op.port, e.id); }
    }
    e.updatedAt = new Date().toISOString();
    this._save();
    this._event('managed_object_updated', { kind: e.kind, id: e.id });
    return { ok: true, object: e };
  }

  /** 注销（销毁时调用）。级联：按所有权释放端口（owner 语义）-> 移出目录 -> 持久化。 */
  unregister(id, opts) {
    const e = this.get(id);
    if (!e) return { ok: false, error: '未注册: ' + id };
    const o = opts || {};
    // 节流游标复位（唯一读写点在 heartbeat），这里是生命周期边界上的清除口
    e._nextTickAt = null;
    // 级联停/清理由调用方决定（域业务保留最终权力）；目录只释放所有权端口（按 owner）并移出簿册
    for (const op of e.ownership.ports) this._releasePort(op.port, e.id);
    if (o.onBeforeRemove) { try { o.onBeforeRemove(e); } catch (err) { this._log('warn', 'onBeforeRemove(' + e.id + '): ' + (err && err.message)); } }
    this._drop(e);
    this._save();
    this._event('managed_object_removed', { kind: e.kind, id: e.id });
    return { ok: true };
  }

  /** 释放本对象持有的端口（按 owner）。绝不回退成无 owner 的释放——那会误删他人登记；
   *  owner 不匹配时 release 返回失败是期望行为，不视为错误，仅日志。 */
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

  /*  查询（唯一全系统视图入口）  */
  list() { return this._objects.slice(); }
  get(id) { return this._byId.get(id) || null; }
  byKind(kind) { return this._objects.filter((o) => o.kind === kind); }
  count() { return this._objects.length; }

  /** 唯一心跳：薄委托 runHeartbeat（单拍调度、节流、单对象超时隔离在 control/heartbeat.js）；
   *  观测写入口仍是本实例的 applyObservation/setPhase。 */
  heartbeat(intervalMs) { return runHeartbeat(this, intervalMs); }

  /** 观测写入（仅由 heartbeat/类型 observe 调用；实然不进持久化）。 */
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

  /** 调谐循环对目录项的 phase 写入（由 heartbeat 调用；业务不得直接改）。 */
  setPhase(id, p) {
    const e = this.get(id);
    if (!e) return null;
    if (!PHASES.includes(p)) return e;
    if (e.phase !== p) {
      e.phase = p;
      e.lastTransitionAt = new Date().toISOString();
      this._event('managed_object_phase', { kind: e.kind, id: e.id, phase: p });
      this._save(); // 受管阶段随目录持久化（重启恢复；观测不入册）
    }
    return e;
  }
}

module.exports = { ManagedRegistry, createEntry, PHASES, DESIRED, MANAGED_KINDS, kindMeta, normalizeOwnership };
