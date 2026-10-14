'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeDurable } = require('../../platform/util/fs');

class RouterStore {
  constructor(opts) {
    this.file = opts.file;
    this.logger = (opts && opts.logger) || null;
    this._writable = true;
    // 配置是否处于「隔离」状态：读/解析失败时置位，本进程禁止任何写入。
    // 这是 canPersist 的唯一判据来源（与 _writable 并列，而非另开一条 loadedOk 通道）。
    this._quarantine = null;
  }

  load() {
    this._quarantine = null;
    let raw = null;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch { return { providers: [] }; }
    try {
      const doc = JSON.parse(raw);
      return { providers: Array.isArray(doc.providers) ? doc.providers : [] };
    } catch (e) {
      const bak = this.file + '.corrupt-' + Date.now();
      // 复制留证，不搬走原文件。搬走会让下次启动看到 ENOENT，于是「配置损坏」
      // 被洗成「从来没有过供应商」，随后任意一次 save 用空态覆盖写出新的 providers.json，
      // 两次启动之间的用户改动全部蒸发。与 instance/store.js 的 keepOriginal 语义一致。
      try { fs.copyFileSync(this.file, bak); }
      catch (e2) {
        if (this.logger && this.logger.error) this.logger.error('[router] providers.json 现场备份失败: ' + (e2 && e2.message));
        this._quarantine = { error: String(e && e.message), backup: null };
        return { providers: [], corrupt: true, backup: null };
      }
      this._quarantine = { error: String(e && e.message), backup: bak };
      if (this.logger && this.logger.error) {
        this.logger.error('[router] providers.json 解析失败（' + e.message + '）——已**复制**保留现场为 ' + bak +
          '，原文件原地不动，本次进程禁止写入（防配置静默清零）');
      }
      return { providers: [], corrupt: true, backup: bak };
    }
  }

  // 配置隔离状态（供 API 层透出），未隔离时为 null。
  quarantine() { return this._quarantine; }

  canPersist() { return this._writable !== false && this._quarantine === null; }

  setPersistEnabled(v) { this._writable = v !== false; }

  save(providers) {
    if (!this.canPersist()) {
      if (this._quarantine && this.logger && this.logger.warn) {
        this.logger.warn('router save skipped：providers.json 处于隔离状态（现场备份 ' + this._quarantine.backup +
          '，原文件原地保留），拒绝用空态覆盖');
      }
      return false;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeDurable(this.file, JSON.stringify({ providers: providers.map((p) => p.serialize()) }, null, 2), { mode: 0o600 });
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
