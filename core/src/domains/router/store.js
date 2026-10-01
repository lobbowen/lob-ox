'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');

class RouterStore {
  constructor(opts) {
    this.file = opts.file;
    this.logger = (opts && opts.logger) || null;
    this.loadedOk = false;
    this._writable = true;
  }

  load() {
    this.loadedOk = false;
    let raw = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch { this.loadedOk = true; return { providers: [] }; }
    try {
      const doc = JSON.parse(raw);
      this.loadedOk = true;
      return { providers: Array.isArray(doc.providers) ? doc.providers : [] };
    } catch (e) {
      const bak = this.file + '.corrupt-' + Date.now();
      try { fs.renameSync(this.file, bak); } catch {}
      if (this.logger && this.logger.error) {
        this.logger.error('[router] providers.json 解析失败（' + e.message + '）——已保留现场为 ' + bak +
          '，本次**不覆盖**该文件（防配置静默清零）');
      }
      return { providers: [], corrupt: true, backup: bak };
    }
  }

  canPersist() { return this._writable !== false && this.loadedOk === true; }

  setPersistEnabled(v) { this._writable = v !== false; }

  save(providers) {
    if (!this.canPersist()) {
      if (!this.loadedOk && this.logger && this.logger.warn) {
        this.logger.warn('router save skipped：providers.json 读取异常（已保留现场），拒绝用空态覆盖');
      }
      return false;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify({ providers: providers.map((p) => p.serialize()) }, null, 2), { mode: 0o600 });
    return true;
  }
}

function deserializeProvider(p, deps) {
  const d = deps || {};
  const stateDir = (d.config && d.config.stateFile) ? path.dirname(d.config.stateFile) : null;
  const common = {
    id: p.id, name: p.name, logger: d.logger, events: d.events, dist: d.dist,
    onPersist: d.onPersist, stateDir,
    apiPort: p.apiPort || null, activated: p.activated === true,
  };
  const apps = d.apps || {};
  let prov;
  if (p.kind === 'proxy') {
    prov = d.createProxy({ ...common, kind: 'proxy', proxyAppId: p.proxyAppId, app: apps[p.proxyAppId] || null });
    prov.proxyRunning = !!p.proxyRunning;
    const app = apps[p.proxyAppId] || null;
    prov.instances = (p.instances || []).map((i) => {
      const inst = (typeof d.createInstance === 'function') ? d.createInstance(i) : {
        key: i.key || null, keyId: i.keyId, maskedKey: i.maskedKey, status: 'COLD', healthy: false,
        quota: i.quota || null, registeredAt: i.registeredAt || Date.now(), version: i.version || null,
        port: i.port || null, pid: null,
      };
      inst.app = app;
      inst.logger = d.logger;
      inst.events = d.events;
      return inst;
    });
  } else {
    prov = d.createDirect({ ...common, kind: 'direct', baseUrl: p.baseUrl || '', plan: p.plan || null, pricing: p.pricing || {}, adapter: p.adapter || null, presetId: p.presetId || null });
  }
  prov.selectedAccountKeyId = p.selectedAccountKeyId || p.selectedProxyKeyId || null;
  const restoredActiveId = p.activeAccountKeyId || null;
  prov.accounts = (p.accounts || []).map((a) => {
    const acc = {
      key: a.key || null,
      keyId: a.keyId,
      maskedKey: a.maskedKey,
      status: a.status || a.validity || 'registered',
      quota: a.quota || null,
      registeredAt: a.registeredAt || Date.now(),
      detectError: a.detectError || null,
      nextResetAt: a.nextResetAt || null,
      limit: a.limit || null,
      lastProbeAt: a.lastProbeAt || null,
      lastProbeError: a.lastProbeError || null,
      instance: prov.kind === 'proxy' ? (prov.instances.find((i) => i.keyId === a.keyId) || null) : null,
    };
    if (restoredActiveId && a.keyId === restoredActiveId) prov.activeAccount = acc;
    return acc;
  });
  if (typeof prov._reconcileLock === 'function') { try { prov._reconcileLock(); } catch {} }
  return prov;
}

module.exports = { RouterStore, deserializeProvider };
