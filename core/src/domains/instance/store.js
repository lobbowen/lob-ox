'use strict';

// 唯一持有 instances 活数组：外部经 getter 取同一引用，替换须原地改写，绝不换数组对象（20+ 处持引用直读/splice）。

const fs = require('node:fs');
const path = require('node:path');
const ports = require('../../platform/service/ports').shared;
const { writeAtomic } = require('../../platform/util/fs');
const lease = require('../../platform/util/lease');
const fileProtect = require('../../platform/os/file-protect');
const model = require('./model');
const sandbox = require('./sandbox');

class InstanceStore {
  constructor({ dir, instancesRoot, logger, tokens }) {
    this.dir = dir;
    this.logger = logger;
    this.tokens = tokens || null;
    this.instancesFile = path.join(dir, 'instances.json');
    this.instancesRoot = instancesRoot || path.join(dir, 'instances');
    // 审计 P0-I3：实例域此前无锁文件（对比 ports 有 alloc.lock）。
    // 损坏隔离走"读失败→rename 成 *.corrupt"；若另一写者（CLI/第二守卫）在读取与隔离两步之间落盘，
    // 好文件会被改名隔离 ⇒ 全量静默丢失。加一把 best-effort 锁文件：隔离前先拿锁，
    // 拿不到（另一写者活跃）即放弃隔离，让持有锁的写者安全落盘；lease I3 的 lockRecyclable 防止崩溃死锁。
    this.lockFile = this.instancesFile + '.lock';
    this.instances = [];
    this._lastBody = null;
  }

  load() {
    // Lease I2：先记下读之前的版本戳。若"读取失败"期间文件被另一写者更新，
    // 则说明它**不是损坏**而是"我们读到的是过渡态/并发写入" ⇒ 绝不能隔离掉这个更新的文件。
    const stampBefore = lease.stampOf(this.instancesFile);
    this._loadStamp = stampBefore;
    let raw = null;
    try {
      raw = fs.readFileSync(this.instancesFile, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') this._replace([]);
      else if (lease.stampChanged(this.instancesFile, stampBefore)) {
        // 文件在我们读取期间变了 ⇒ 重新读一次再判定，而不是隔离
        this.logger && this.logger.warn && this.logger.warn('instances.json 读取期间被更新，重新读取而非隔离（防误删新文件）');
        try { raw = fs.readFileSync(this.instancesFile, 'utf8'); } catch { this._quarantineCorrupt(e); }
      } else {
        this._quarantineCorrupt(e);
      }
    }
    if (raw !== null) {
      let doc = null;
      let parsed = true;
      try { doc = JSON.parse(raw); }
      catch (e) {
        parsed = false;
        if (lease.stampChanged(this.instancesFile, stampBefore)) {
          this.logger && this.logger.warn && this.logger.warn('instances.json 解析期间被更新，放弃本次隔离判定');
        } else {
          this._quarantineCorrupt(e);
        }
      }
      if (parsed) this._replace(doc && Array.isArray(doc.instances) ? doc.instances : []);
    }
    for (const inst of this.instances) {
      model.normalizeInstance(inst);
      this._stripLegacyStateKeys(inst);
      if (inst.domain === 'sandbox' && this.tokens) this.tokens.attach(inst.id, { unit: 'dsh-web@' + inst.id });
    }
    this.syncPorts();
    return this.instances;
  }

  _stripLegacyStateKeys(inst) {
    if (inst.state && Object.prototype.hasOwnProperty.call(inst.state, 'version')) delete inst.state.version;
  }

  /**
   * 隔离损坏文件。
   * Lease I2：隔离前**再次校验版本戳**——若自读取失败以来文件已被他人更新，
   * 说明它不是损坏 ⇒ 放弃隔离（修前会直接 rename 掉这个更新的文件并把实例列表清空，即全量静默丢失）。
   * 且保留可回溯副本：先复制再改名，不直接丢弃。
   */
  _quarantineCorrupt(err) {
    // 审计 P0-I3：隔离前先取 best-effort 锁（I1 同步 test-and-set；失败=另一写者活跃 ⇒ 放弃隔离，让其安全落盘）。
    let locked = false;
    try { fs.openSync(this.lockFile, 'wx'); fs.writeFileSync(this.lockFile, String(process.pid)); locked = true; }
    catch { /* 锁已存在 ⇒ 有并发写者 ⇒ 绝不隔离，防误删其新鲜文件 */ }
    if (!locked) {
      this.logger && this.logger.warn && this.logger.warn('instances.json 隔离前取锁失败（并发写者活跃），放弃隔离（防误删新文件）');
      return;
    }
    const stampNow = lease.stampOf(this.instancesFile);
    if (this._loadStamp && stampNow !== this._loadStamp) {
      this.logger && this.logger.warn && this.logger.warn('instances.json 已被其他写者更新，放弃隔离（当前版本 ' + stampNow + '）');
      return;
    }
    const bak = this.instancesFile + '.corrupt-' + Date.now();
    this.logger && this.logger.warn && this.logger.warn('instances.json 读取/解析失败，备份后清空: ' + (err && err.message) + ' -> ' + bak);
    try {
      // 保留可回溯副本后再改名，避免"隔离"本身变成不可逆删除。
      try { fs.copyFileSync(this.instancesFile, bak); }
      catch { /* 复制失败则退化为改名（保留原行为） */ fs.renameSync(this.instancesFile, bak); return; }
      fs.renameSync(this.instancesFile, bak + '.orig');
    } catch (e2) {
      this.logger && this.logger.warn && this.logger.warn('instances.json 损坏现场备份失败: ' + (e2 && e2.message));
    }
    this._replace([]);
    // 审计 P0-I3：隔离完成（无论成功/失败）即释放锁，使并发写者能继续安全落盘。
    try { fs.unlinkSync(this.lockFile); } catch {  }
  }

  _replace(list) {
    if (list === this.instances) return;
    this.instances.length = 0;
    for (const i of list) this.instances.push(i);
  }

  replace(list) { this._replace(list); }

  save() {
    // 审计 P0-I3：写盘期间取 best-effort 锁，使其与隔离（rename）互斥，杜绝"读取失败→隔离"把本应落盘的新文件误删。
    let locked = false;
    try { fs.openSync(this.lockFile, 'wx'); fs.writeFileSync(this.lockFile, String(process.pid)); locked = true; }
    catch { /* 锁已存在 ⇒ 另一写者活跃 ⇒ 跳过本次写盘，下一拍重试（数据仍在内存，不会丢） */ }
    if (!locked) { return; }
    try {
      const body = JSON.stringify({ instances: this.instances }, null, 2);
      if (body === this._lastBody) return;
      this._lastBody = body;
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.instancesFile, body, { mode: 0o600 });
    } catch (e) {
      this.logger && this.logger.error && this.logger.error('instances.json 持久化失败: ' + (e && e.message));
    } finally {
      // 审计 P0-I3：写盘结束即释放锁。
      try { fs.unlinkSync(this.lockFile); } catch {  }
    }
  }

  syncPorts() {
    for (const inst of this.instances) {
      const id = String(inst.id || '');
      const port = Number(inst.port);
      if (!id || !Number.isInteger(port) || port <= 0) continue;
      try {
        const bound = ports.byOwner('inst:' + id);
        if (bound !== null && Number(bound) !== port) ports.unregister('inst:' + id);
        if (!ports.isRegistered(port)) ports.registerUser(port, 'inst:' + id);
      } catch (e) { this.logger.warn && this.logger.warn('syncPorts register ' + id + ':' + port + ': ' + e.message); }
    }
    try {
      for (const rec of ports.list()) {
        if (!String(rec.owner || '').startsWith('inst:')) continue;
        const id = String(rec.owner).slice(5);
        if (!this.instances.some((i) => String(i.id) === id)) { try { ports.unregister(rec.owner); } catch {} }
      }
    } catch {}
  }

  ensureDirs(inst) {
    const r = fileProtect.ensurePrivateDir(sandbox.root(this.instancesRoot, inst));
    if (r && r.ok === false) this.logger && this.logger.warn && this.logger.warn('实例根权限收紧失败 ' + r.mode + ': ' + r.reason);
    fs.mkdirSync(sandbox.dataDir(this.instancesRoot, inst), { recursive: true });
    fs.mkdirSync(sandbox.installDir(this.instancesRoot, inst), { recursive: true });
    fs.mkdirSync(sandbox.tmpDir(this.instancesRoot, inst), { recursive: true });
  }
}

module.exports = { InstanceStore };
