'use strict';

const path = require('node:path');
const os = require('node:os');
const sandbox = require('./sandbox');
const { InstanceStore } = require('./store');
const { createLifecycle } = require('./lifecycle');
const { createUpgrade } = require('./upgrade');
const { createOps } = require('./ops');
const service = require('../../platform/os/service').current();
const defaultResstats = require('../../platform/os/resstats');

class InstanceManager {
  constructor(opts) {
    this.dir = opts.dir;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;
    this.dshBin = opts.dshBin || 'dsh';
    this.service = opts.service || service;
    this.tokens = opts.tokenService || null;
    this.tasks = opts.tasks || null;
    this.systemdDir = opts.systemdDir || path.join(os.homedir(), '.config', 'systemd', 'user');
    this.systemdTemplatePath = opts.systemdTemplatePath || path.join(this.systemdDir, 'dsh-web@.service');
    this.resstats = opts.resstats || defaultResstats;
    
    this.throttle = opts.throttle || null;
    // agent 管理域：沙箱实例的 DSH 安装/升级委托它，不维护第二套实现。
    this.agents = opts.agents || null;
    this.instancesRoot = path.join(this.dir, 'instances');
    this._sandboxSupportedOverride = undefined;
    this._hooks = {};
    this._store = new InstanceStore({ dir: this.dir, instancesRoot: this.instancesRoot, logger: this.logger, tokens: this.tokens });
    const ctx = this._ctx = {
      logger: this.logger, events: this.events, dist: this.dist, dshBin: this.dshBin,
      service: this.service, tokens: this.tokens, tasks: this.tasks,
      systemdDir: this.systemdDir, systemdTemplatePath: this.systemdTemplatePath,
      instancesRoot: this.instancesRoot, hooks: this._hooks, store: this._store,
      resstats: this.resstats,
      throttle: this.throttle,
      agents: this.agents,
      isSandboxSupported: () => this.sandboxSupported,
    };
    ctx.lifecycle = this._lifecycle = createLifecycle(ctx);
    ctx.upgrade = this._upgrade = createUpgrade(ctx);
    ctx.install = (inst) => this._upgrade.installSandbox(inst);
    ctx.ops = this._ops = createOps(ctx);
  }

  get instances() { return this._store.instances; }
  set instances(list) { this._store.replace(list); }

  all() { return this._store.instances; }
  forEach(fn) { return this._store.instances.forEach(fn); }
  find(id) { return this._store.instances.find((i) => i.id === id); }
  map(fn) { return this._store.instances.map(fn); }

  
  // 平台能力判定（与配额无关）：当前平台能否以独立 unit 形式拉起沙箱实例。
  // 原在 governor.js，随配额逻辑删除时一并内联到这里。
  get sandboxSupported() {
    if (this._sandboxSupportedOverride !== undefined && this._sandboxSupportedOverride !== null) return this._sandboxSupportedOverride === true;
    try {
      const caps = require('../../platform/os/index').capabilities();
      return !!(caps && caps.sandboxLaunch === true);
    } catch { return false; }
  }
  _setSandboxSupportedForTest(v) { this._sandboxSupportedOverride = (v === null ? null : v === true); }

  get onRemoteChange() { return this._hooks.onRemoteChange || null; }
  set onRemoteChange(fn) { this._hooks.onRemoteChange = fn; }
  get onRemove() { return this._hooks.onRemove || null; }
  set onRemove(fn) { this._hooks.onRemove = fn; }
  get onInstanceStart() { return this._hooks.onInstanceStart || null; }
  set onInstanceStart(fn) { this._hooks.onInstanceStart = fn; }
  get onInstanceStop() { return this._hooks.onInstanceStop || null; }
  set onInstanceStop(fn) { this._hooks.onInstanceStop = fn; }
  get onCreate() { return this._hooks.onCreate || null; }
  set onCreate(fn) { this._hooks.onCreate = fn; }
  get onDestroy() { return this._hooks.onDestroy || null; }
  set onDestroy(fn) { this._hooks.onDestroy = fn; }

  load() { return this._store.load(); }
  save() { return this._store.save(); }
  list() { return this._ops.list(); }
  addInstance(payload) { return this._ops.addInstance(payload); }
  removeInstance(id) { return this._ops.removeInstance(id); }
  updateInstance(id, patch) { return this._ops.updateInstance(id, patch); }
  startInstance(id, opts) { return this._lifecycle.start(id, opts); }
  stopInstance(id) { return this._lifecycle.stop(id); }
  supervise(id) { return this._lifecycle.supervise(id); }
  probeInstance(id) { return this._lifecycle.probeInstance(id); }
  checkUpdate(id) { return this._upgrade.checkUpdate(id); }
  upgradeInstance(id) { return this._upgrade.upgradeInstance(id); }
  upgradeStatus(id) { return this._upgrade.upgradeStatus(id); }
  sandboxRoot(inst) { return sandbox.root(this.instancesRoot, inst); }
  sandboxDataDir(inst) { return sandbox.dataDir(this.instancesRoot, inst); }
  sandboxInstallDir(inst) { return sandbox.installDir(this.instancesRoot, inst); }
  launchCtx(inst) { return sandbox.launchCtx(this.instancesRoot, this.dshBin, inst); }
  _prepareSystemd() { return this._lifecycle._prepareSystemd(); }
}

module.exports = { InstanceManager };
