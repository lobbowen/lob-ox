'use strict';

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
    
    
    
    
    this.lockFile = this.instancesFile + '.lock';
    this.instances = [];
    this._lastBody = null;
  }

  load() {
    
    
    const stampBefore = lease.stampOf(this.instancesFile);
    this._loadStamp = stampBefore;
    let raw = null;
    try {
      raw = fs.readFileSync(this.instancesFile, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') this._replace([]);
      else if (lease.stampChanged(this.instancesFile, stampBefore)) {
        
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

  
  _quarantineCorrupt(err) {
    
    let locked = false;
    try { fs.openSync(this.lockFile, 'wx'); fs.writeFileSync(this.lockFile, String(process.pid)); locked = true; }
    catch {  }
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
      
      try { fs.copyFileSync(this.instancesFile, bak); }
      catch {  fs.renameSync(this.instancesFile, bak); return; }
      fs.renameSync(this.instancesFile, bak + '.orig');
    } catch (e2) {
      this.logger && this.logger.warn && this.logger.warn('instances.json 损坏现场备份失败: ' + (e2 && e2.message));
    }
    this._replace([]);
    
    try { fs.unlinkSync(this.lockFile); } catch {  }
  }

  _replace(list) {
    if (list === this.instances) return;
    this.instances.length = 0;
    for (const i of list) this.instances.push(i);
  }

  replace(list) { this._replace(list); }

  save() {
    
    let locked = false;
    try { fs.openSync(this.lockFile, 'wx'); fs.writeFileSync(this.lockFile, String(process.pid)); locked = true; }
    catch {  }
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
