'use strict';

const managed = require('./managed');
const portsvc = require('./ports');
const { FrpManager } = require('./frp');
const { normalizeRemoteMode, validateWanAccess, normalizeFrpSettings, validateFrpServerSettings, projectRemoteView } = require('./core');
const reconcile = require('./ops/reconcile');
const lanServers = require('./ops/lan-servers');

function applyRelayToken(host, existing, want) {
  const s = host._lanServers && host._lanServers[existing.id];
  if (!s || typeof s.setToken !== 'function') return false;
  try { s.setToken(want); } catch {}
  existing.token = want;
  if (host.events) host.events.append('lan_token_updated', { id: existing.id, tokenSet: !!want });
  host.syncFrpc();
  return true;
}

function onRelayBindingLost(host, inst, e) {
  if (host.events) { try { host.events.append('lan_binding_lost', e); } catch {} }
  if (host.logger && host.logger.warn) host.logger.warn('[syncProxy] ' + inst.id + ' 绑定被盗：' + e.from + ' → 迁移 ' + e.to);
}

class LanManager {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.instances = opts.instances;
    this.configPath = opts.configPath || '';
    this.mainOf = opts.mainOf || null;
    this.frp = opts.frp || new FrpManager({ dir: opts.stateDir, logger: this.logger, events: this.events });
    this.lanInstances = [];
    this._reconcileInFlight = null;
    this._lanServers = {};
    this.tokenOf = opts.tokenOf || (() => '');
    this._proxyChain = Promise.resolve();
  }

  localAddresses() { return managed.localAddresses(); }
  _allManaged() { return managed.allManaged({ instances: this.instances, mainOf: this.mainOf }); }
  frpChild() { return (this.frp && this.frp.child) || null; }

  list() {
    this.reconcile().catch(() => {});
    const addresses = this.localAddresses();
    const insts = this._allManaged();
    const remoteInsts = insts.filter((x) => normalizeRemoteMode(x.remoteMode) !== 'off');
    for (const inst of remoteInsts) {
      if (!this.lanInstances.some((p) => p.dshPort === inst.port)) {
        this._syncProxyQueued(inst).catch((e) => this.logger.warn && this.logger.warn('syncProxy failed: ' + e.message));
      }
    }
    const frpSt = this.frp ? this.frp.status() : { running: false, settings: {} };
    const items = remoteInsts.map((inst) => {
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      const srv = this._lanServers && this._lanServers[inst.id];
      const st = (srv && typeof srv.status === 'function') ? srv.status() : null;
      const inject = st ? {
        tokenSet: !!st.tokenSet, cookieReady: !!st.cookieReady,
        lastOkAt: st.lastOkAt || null, lastError: st.lastError || null, lastErrorAt: st.lastErrorAt || null,
      } : null;
      const remote = projectRemoteView({
        mode: normalizeRemoteMode(inst.remoteMode),
        relayListening: !!(this._lanServers && this._lanServers[inst.id]),
        tokenSet: !!String(inst.remoteToken || '').trim(),
        cookieReady: !!(st && st.cookieReady),
        frpcRunning: !!frpSt.running,
        serverAddr: (frpSt.settings && frpSt.settings.serverAddr) || '',
        lanAddress: addresses[0] || '',
        wanPort: proxy ? proxy.wanPort : null,
      });
      return {
        id: inst.id, name: inst.name, dshPort: inst.port,
        wanPort: proxy ? proxy.wanPort : null,
        token: inst.remoteToken || '',
        dshToken: this.tokenOf(inst.id) || '',
        running: !!this._lanServers && !!this._lanServers[inst.id],
        inject, remote,
      };
    });
    return { items, addresses };
  }
  frpStatus() {
    const st = this.frp ? this.frp.status() : { installed: false, running: false };
    const insts = this._allManaged();
    st.instancesExposed = insts
      .filter((x) => normalizeRemoteMode(x.remoteMode) === 'wan')
      .map((x) => {
        const proxy = this.lanInstances.find((p) => p.dshPort === x.port);
        return { id: x.id, name: x.name, port: proxy ? proxy.wanPort : null };
      });
    return st;
  }
  async frpAction(action, body) {
    const j = body || {};
    if (action === 'settings') {
      const cur = this.frp ? this.frp.loadSettings() : {};
      const next = normalizeFrpSettings(j, cur);
      if (!String(next.serverAddr || '').trim() && this._hasWanIntent()) {
        return { ok: false, error: validateFrpServerSettings(next).error };
      }
      if (this.frp) this.frp.saveSettings(next);
      this.syncFrpc();
      return { ok: true, ...this.frpStatus() };
    }
    if (action === 'install') {
      if (!this.frp) return { ok: false, error: 'frpmgr 不可用' };
      return this.frp.install((msg) => { try { this.logger.info('[frpc] ' + msg); } catch {} });
    }
    return { ok: false, error: '未知 frp 操作: ' + action };
  }
  _hasWanIntent() {
    return this._allManaged().some((x) => normalizeRemoteMode(x.remoteMode) === 'wan');
  }
  syncFrpc() {
    if (!this.frp) return;
    try {
      const all = this.lanInstances || [];
      const safe = all.filter((inst) => {
        if (normalizeRemoteMode(inst.remoteMode) !== 'wan') return true;
        const v = validateWanAccess({ remoteToken: String(inst.token || '') });
        if (!v.ok) {
          if (this.logger && this.logger.warn) this.logger.warn('[frpc] 实例 ' + inst.id + ' 公网访问未过闸，已跳过建隧道：' + v.error);
          if (this.events) this.events.append('lan_frp_blocked', { id: inst.id, reason: v.error });
          return false;
        }
        return true;
      });
      const r = this.frp.syncFromInstances(safe);
      if (r && r.needInstall) this.logger.info && this.logger.info('frpc not installed; WAN exposure pending install');
    } catch (e) {
      this.logger.warn && this.logger.warn('frpc sync failed: ' + e.message);
    }
  }
  reconcile() {
    if (this._reconcileInFlight) return this._reconcileInFlight;
    this._reconcileInFlight = this._reconcileOnce()
      .catch((e) => { this.logger.warn && this.logger.warn('[reconcile] ' + ((e && e.message) || e)); })
      .finally(() => { this._reconcileInFlight = null; });
    return this._reconcileInFlight;
  }
  async _reconcileOnce() { return reconcile.reconcileOnce(this); }
  targetReachable(inst) { return reconcile.targetReachable(inst); }
  _syncProxyQueued(inst) { return reconcile.syncProxyQueued(this, inst); }
  async removeProxyForInstance(instId) { return reconcile.removeProxyForInstance(this, instId); }

  async syncProxy(inst) {
    if (!inst) return;
    const mode = normalizeRemoteMode(inst.remoteMode);
    if (mode !== 'off') {
      const owner = 'relay:' + inst.id;
      const existing = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (existing && existing.wanPort) {
        const srv = this._lanServers && this._lanServers[inst.id];
        if (!srv) this._startLanServer(existing);
        const want = String(inst.remoteToken || '');
        if (existing.token !== want) applyRelayToken(this, existing, want);
        if (existing.remoteMode !== mode) {
          existing.remoteMode = mode;
          this.syncFrpc();
        }
        return;
      }
      if (!(await this.targetReachable(inst))) return;
      const relayPool = portsvc.rangeOf('relay');
      const slot = await portsvc.claim('relay', owner, {
        preferred: !existing && inst.id === 'main' ? relayPool.base : undefined,
        onBindingLost: (e) => onRelayBindingLost(this, inst, e),
        configPath: this.configPath,
      });
      if (!slot || slot.conflict) {
        if (this.logger && this.logger.warn) this.logger.warn('[syncProxy] ' + inst.id + ' relay 槽位冲突（' + (slot && slot.port) + ' 被外部占用且无法回收），不静默跳号，等待下轮');
        return;
      }
      const wanPort = slot.port;
      const oldSrv = this._lanServers && this._lanServers[inst.id];
      const oldPort = existing && existing.wanPort;
      if (oldSrv && oldPort && oldPort !== wanPort) {
        try { oldSrv.close(() => {}); } catch {}
        try { if (typeof oldSrv.closeAllConnections === 'function') oldSrv.closeAllConnections(); } catch {}
        delete this._lanServers[inst.id];
        if (this.logger && this.logger.info) this.logger.info('[syncProxy] ' + inst.id + ' 关闭旧端口 ' + oldPort + ' server（换绑 ' + wanPort + '）');
      }
      portsvc.purgeDuplicates(owner, wanPort);
      portsvc.ensureMarked(wanPort, owner);
      const proxyInst = { id: inst.id, name: inst.name, dshPort: inst.port, wanPort, token: inst.remoteToken || '', remoteMode: mode };
      if (existing) { Object.assign(existing, proxyInst); }
      else this.lanInstances.push(proxyInst);
      this._startLanServer(existing || proxyInst);
      if (this.events) this.events.append('lan_instance_added', { id: inst.id, name: inst.name, dshPort: inst.port, wanPort });
      this.syncFrpc();
    } else {
      const proxy = this.lanInstances.find((p) => p.dshPort === inst.port);
      if (proxy) {
        this._stopLanServer(proxy.id);
        this.lanInstances = this.lanInstances.filter((p) => p.id !== proxy.id);
        if (this.events) this.events.append('lan_instance_removed', { id: proxy.id, reason: 'disabled' });
        this.syncFrpc();
      }
    }
  }
  async instanceStart(inst) { return reconcile.instanceStart(this, inst); }
  instanceStop(inst) { return reconcile.instanceStop(this, inst); }
  _startLanServer(inst) { return lanServers.startLanServer(this, inst); }
  _stopLanServer(id) { return lanServers.stopLanServer(this, id); }
  shutdown() { return lanServers.shutdown(this); }
  applyToken(instId) { return lanServers.applyToken(this, instId); }
}

module.exports = { LanManager };
