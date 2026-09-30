'use strict';

// 智能路由底座（RouterService）：薄门面，只做组合与委托，零业务逻辑（DF-1 <=150）。
// 业务下沉 store/ops/endpoint/views/scheduler + forward-core/router-ops 显式工厂。

const { DirectProvider } = require('./providers/direct');
const { ProxyProvider } = require('./providers/proxy');
const { SwitchEngine } = require('./switch');
const { RouterStore, deserializeProvider } = require('./store');
const { PROVIDER_PRESETS, quotaOverallStatus } = require('./providers/base');
const { PROXY_APPS } = require('./proxy-apps');
const { ProxyInstance } = require('./model');
const { semverCompare } = require('../../shared/version');
const ports = require('../../platform/service/ports').shared;
const probe = require('../../platform/util/probe');
const { createForwardCore } = require('./forward-core');
const { createAuxCore } = require('./router-ops');
const views = require('./views');
const { createScheduler } = require('./scheduler');
const endpoint = require('./endpoint');
const ops = require('./ops');

class RouterService {
  constructor(opts) {
    this.config = opts.config;
    this.dist = opts.dist || null;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.tasks = opts.tasks || null;
    this.providerFile = opts.providerFile;
    this.usageTotalsFile = opts.usageTotalsFile || null;
    if (opts && opts.portsFile) ports.configureFile(opts.portsFile); // 端口注册表隔离（测试注入独立文件）

    const state = ops.createState();
    this._state = state;
    const agents = endpoint.createAgents();
    state.agentHttp = agents.http; state.agentHttps = agents.https;

    this.store = this._store = new RouterStore({ file: this.providerFile, logger: this.logger });
    const doc = this.store.load();
    state.providers = (doc.providers || []).map((p) => deserializeProvider(p, {
      createDirect: (o) => new DirectProvider(o), createProxy: (o) => new ProxyProvider(o),
      createInstance: (i) => ProxyInstance.fromJSON(i), apps: PROXY_APPS,
      logger: this.logger, events: this.events, dist: this.dist, onPersist: () => this._save(), config: this.config,
    }));
    for (const p of state.providers) { // 恢复持久化 apiPort 登记（owner=providerApi:<id>；防重复分配）
      if (p.apiPort) { try { if (!ports.isRegistered(p.apiPort)) ports.registerUser(p.apiPort, 'providerApi:' + p.id); } catch {} }
    }
    this.switcher = new SwitchEngine({ logger: this.logger, events: this.events, onPersist: () => this._save() });

    this._forward = createForwardCore({
      log: (line) => state.log(line), logger: this.logger, canPersist: () => this.store.canPersist(),
      switcher: this.switcher, events: this.events, usageTotalsFile: this.usageTotalsFile,
      getPricing: () => state.modelPriceIndex, agents,
    });
    this._aux = createAuxCore({
      getProviders: () => state.providers, findProvider: (id) => ops.findProvider(state.providers, id),
      save: () => this._save(), proxyUpdateCache: state.proxyUpdateCache,
      dist: this.dist, events: this.events, tasks: this.tasks, logger: this.logger,
      setPriceIndex: (idx) => { state.modelPriceIndex = idx; },
    });
    this._scheduler = createScheduler({
      state, store: this.store, logger: this.logger,
      refreshProxyUpdateInfo: () => this.refreshProxyUpdateInfo(),
      refreshOfficialUsageAll: () => this.refreshOfficialUsageAll(),
      refreshOfficialPricingAll: () => this.refreshOfficialPricingAll(),
    });
    this._endpoint = endpoint.createEndpoint({
      state, logger: this.logger, events: this.events, ports, forward: this._forward,
      getProvider: (id) => ops.findProvider(state.providers, id), save: () => this._save(), scheduler: this._scheduler,
    });
    this._ops = ops.createOps({
      state, store: this.store, logger: this.logger, events: this.events, dist: this.dist, ports,
      endpoint: this._endpoint, scheduler: this._scheduler, usage: this._forward.usage,
      createDirect: (o) => new DirectProvider(o), createProxy: (o) => new ProxyProvider(o),
      apps: PROXY_APPS, presets: PROVIDER_PRESETS, save: () => this._save(),
    });
    this._viewDeps = { getUsage: () => this._forward.usage.getUsage(), quotaOverallStatus, semverCompare, ports, probe };
  }

  get providers() { return this._state.providers; }
  set providers(v) { this._state.providers = v; }
  get _maintTimer() { return this._state.maintTimer; }
  get _pricingTimer() { return this._state.pricingTimer; }
  get _lifecycleTimer() { return this._state.lifecycleTimer; }

  canPersist() { return this.store.canPersist(); }
  setPersistEnabled(v) { return this.store.setPersistEnabled(v); }
  _save() { return this.store.save(this._state.providers); }
  log(line) { this._state.log(line); }
  readBody(req) { return endpoint.readBody(req); }
  getProvider(id) { return ops.findProvider(this._state.providers, id); }

  status() { return views.status(this._state, this._viewDeps); }
  domainSummary() { return views.domainSummary(this._state, { ports }); }
  portsView() { return views.portsView(this._state, { ports, probe }); }
  listProviders() { return views.listProviders(this._state, this._viewDeps); }

  handleForProvider(id, req, res) { return this._endpoint.handleForProvider(id, req, res); }
  activateProvider(id) { return this._endpoint.activateProvider(id); }
  deactivateProvider(id) { return this._endpoint.deactivateProvider(id); }
  _newServer(h) { return this._endpoint.newServer(h); }
  _startProviderServer(id) { return this._endpoint.startProviderServer(id); }
  _stopProviderServer(id) { return this._endpoint.stopProviderServer(id); }
  _startActivatedProviders() { return this._endpoint.startActivatedProviders(); }

  proxyFor(prov, req, res) { return this._forward.proxyFor(prov, req, res); }
  getUsage() { return this._forward.usage.getUsage(); }
  recordUsage(entry) { return this._forward.usage.recordUsage(entry); }
  recordError() { return this._forward.recordError(); }

  /* 注册表 + 生命周期 */
  addDirectProvider(o) { return this._ops.addDirectProvider(o); }
  addProxyProvider(o) { return this._ops.addProxyProvider(o); }
  removeProvider(id) { return this._ops.removeProvider(id); }
  start() { return this._ops.start(); }
  stop() { return this._ops.stop(); }
  stopAndWait(t) { return this._ops.stopAndWait(t); }
  stopAllInstances() { return this._ops.stopAllInstances(); }

  /* 调度 */
  _startMaintenance() { return this._scheduler.start(); }
  _stopMaintenance() { return this._scheduler.stop(); }
  _ensureProxyInstances() { return this._scheduler.ensureProxyInstances(); }
  _probeAccountStates() { return this._scheduler.probeAccountStates(); }
  _stopIdleProxyInstances() { return this._scheduler.reconcileInstances(); }
  _ensureProviderInstances(p) { return this._scheduler.ensureProviderInstances(p); }

  /* 运维门面 */
  commandcodeLoginStart() { return this._aux.commandcodeLoginStart(); }
  commandcodeLoginWait(t) { return this._aux.commandcodeLoginWait(t); }
  proxyApps() { return this._aux.proxyApps(); }
  refreshProxyUpdateInfo(force) { return this._aux.refreshProxyUpdateInfo(force); }
  applyProxyUpdate(appId) { return this._aux.applyProxyUpdate(appId); }
  proxyUpdateStatus(appId) { return this._aux.proxyUpdateStatus(appId); }
  refreshOfficialUsageAll() { return this._aux.refreshOfficialUsageAll(); }
  refreshProviderQuota(id) { return this._aux.refreshProviderQuota(id); }
  refreshOfficialPricingAll() { return this._aux.refreshOfficialPricingAll(); }
  setProviderKeys(id, o) { return this._aux.setProviderKeys(id, o); }
  setSelectedProxyKey(pid, kid) { return this._aux.setSelectedProxyKey(pid, kid); }
  switchToKey(pid, kid) { return this._aux.switchToKey(pid, kid); }
  removeProxyKey(pid, kid) { return this._aux.removeProxyKey(pid, kid); }
  addProxyKey(pid, key) { return this._aux.addProxyKey(pid, key); }
  discardAccount(pid, kid) { return this._aux.discardAccount(pid, kid); }
}

RouterService.presets = () => PROVIDER_PRESETS || [];

module.exports = { RouterService };
