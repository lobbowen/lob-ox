'use strict';

// 唯一持有 instances 活数组：外部经 getter 取同一引用，替换须原地改写，绝不换数组对象（20+ 处持引用直读/splice）。

const fs = require('node:fs');
const path = require('node:path');
const ports = require('../../platform/service/ports').shared;
const { writeAtomic } = require('../../platform/util/fs');
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
    this.instances = [];
    this._lastBody = null;
  }

  load() {
    let raw = null;
    try {
      raw = fs.readFileSync(this.instancesFile, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') this._replace([]);
      else this._quarantineCorrupt(e);
    }
    if (raw !== null) {
      let doc = null;
      let parsed = true;
      try { doc = JSON.parse(raw); } catch (e) { parsed = false; this._quarantineCorrupt(e); }
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
    const bak = this.instancesFile + '.corrupt-' + Date.now();
    this.logger && this.logger.warn && this.logger.warn('instances.json 读取/解析失败，备份后清空: ' + (err && err.message) + ' -> ' + bak);
    try { fs.renameSync(this.instancesFile, bak); }
    catch (e2) { this.logger && this.logger.warn && this.logger.warn('instances.json 损坏现场备份失败: ' + (e2 && e2.message)); }
    this._replace([]);
  }

  _replace(list) {
    if (list === this.instances) return;
    this.instances.length = 0;
    for (const i of list) this.instances.push(i);
  }

  replace(list) { this._replace(list); }

  save() {
    try {
      const body = JSON.stringify({ instances: this.instances }, null, 2);
      if (body === this._lastBody) return;
      this._lastBody = body;
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.instancesFile, body, { mode: 0o600 });
    } catch (e) {
      this.logger && this.logger.error && this.logger.error('instances.json 持久化失败: ' + (e && e.message));
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
