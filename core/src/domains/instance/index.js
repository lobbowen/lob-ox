'use strict';

const path = require('node:path');
const os = require('node:os');
const sandbox = require('./sandbox');
const governor = require('./governor');
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
    this.machineFacts = opts.machineFacts || null;
    // 实例域启动失败限流参数（按域参数化；算法本体仍在 shared/guardian.bumpStartupFailure，与主链同源）。
    this.throttle = opts.throttle || null;
    this.instancesRoot = path.join(this.dir, 'instances');
    this._sandboxSupportedOverride = undefined;
    this._hooks = {};
    this._store = new InstanceStore({ dir: this.dir, instancesRoot: this.instancesRoot, logger: this.logger, tokens: this.tokens });
    const ctx = this._ctx = {
      logger: this.logger, events: this.events, dist: this.dist, dshBin: this.dshBin,
      service: this.service, tokens: this.tokens, tasks: this.tasks,
      systemdDir: this.systemdDir, systemdTemplatePath: this.systemdTemplatePath,
      instancesRoot: this.instancesRoot, hooks: this._hooks, store: this._store,
      resstats: this.resstats, machineFacts: this.machineFacts,
      throttle: this.throttle,
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

  // 能力判定读平台表（有副作用）⇒ 从 governor 取，不经 pure 的 sandbox.js。
  get sandboxSupported() { return governor.sandboxSupported(this._sandboxSupportedOverride); }
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
  governSweep() { return this._lifecycle.governSweep(); }
  probeInstance(id) { return this._lifecycle.probeInstance(id); }
  budgetSnapshot() { return governor.budgetSnapshot(this._store.instances, this.machineFacts || undefined); }
  checkUpdate(id) { return this._upgrade.checkUpdate(id); }
  upgradeInstance(id) { return this._upgrade.upgradeInstance(id); }
  upgradeStatus(id) { return this._upgrade.upgradeStatus(id); }
  startTimer(ms) { return this._ops.startTimer(ms); }
  sandboxRoot(inst) { return sandbox.root(this.instancesRoot, inst); }
  sandboxDataDir(inst) { return sandbox.dataDir(this.instancesRoot, inst); }
  sandboxInstallDir(inst) { return sandbox.installDir(this.instancesRoot, inst); }
  launchCtx(inst) { return sandbox.launchCtx(this.instancesRoot, this.dshBin, inst); }
  _prepareSystemd() { return this._lifecycle._prepareSystemd(); }
}

module.exports = { InstanceManager };
