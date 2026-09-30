'use strict';

// 多实例管理器：门面 + 组装根，只做组合与委托（构造纯模块/IO 模块、注入协作方），不含业务逻辑。
// 对外契约面见 contract.js（exports 与 PUBLIC_API 由门禁校验）。
// 域内依赖：index -> ops -> lifecycle -> store -> model/sandbox/state-machine（单向 DAG）。

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
    this.dir = opts.dir;                 // 守卫状态目录（默认 <产品状态根>/supervisor）
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;       // 统一分发：沙箱 npm 安装与 DSH 自升级共用全局镜像源
    this.dshBin = opts.dshBin || 'dsh';
    this.service = opts.service || service;   // 平台服务控制器：可注入（测试显式注入，不 patch 模块导出）
    this.tokens = opts.tokenService || null;  // 唯一令牌节点：只登记「源」，不持有/转发令牌
    this.tasks = opts.tasks || null;          // 统一安装/更新任务注册表
    this.systemdDir = opts.systemdDir || path.join(os.homedir(), '.config', 'systemd', 'user');
    this.systemdTemplatePath = opts.systemdTemplatePath || path.join(this.systemdDir, 'dsh-web@.service');
    // W2 控制面注入缝：采样与机器事实可替换（行为测试显式注入，不 patch 模块导出）。
    this.resstats = opts.resstats || defaultResstats;
    this.machineFacts = opts.machineFacts || null;
    this.instancesRoot = path.join(this.dir, 'instances');
    this._sandboxSupportedOverride = undefined;
    this._hooks = {}; // 6 个回调活对象（compose.js 直接赋值访问器，见下）
    this._store = new InstanceStore({ dir: this.dir, instancesRoot: this.instancesRoot, logger: this.logger, tokens: this.tokens });
    const ctx = this._ctx = {
      logger: this.logger, events: this.events, dist: this.dist, dshBin: this.dshBin,
      service: this.service, tokens: this.tokens, tasks: this.tasks,
      systemdDir: this.systemdDir, systemdTemplatePath: this.systemdTemplatePath,
      instancesRoot: this.instancesRoot, hooks: this._hooks, store: this._store,
      resstats: this.resstats, machineFacts: this.machineFacts,
      isSandboxSupported: () => this.sandboxSupported,
    };
    ctx.lifecycle = this._lifecycle = createLifecycle(ctx);
    ctx.upgrade = this._upgrade = createUpgrade(ctx);
    ctx.install = (inst) => this._upgrade.installSandbox(inst); // 注入而非 require（避免 lifecycle 与 upgrade 成环）
    ctx.ops = this._ops = createOps(ctx);
  }

  /** instances 活数组：每次返回 store 当前数组（身份稳定；app/state/store.js 等 20+ 处持引用直读/splice）。
   *  跨域消费方（DG-11）只经下面的查询接口取用，不直读本内部活数组。 */
  get instances() { return this._store.instances; }
  set instances(list) { this._store.replace(list); }

  // 查询接口（DG-11 契约面）：每次经 store 取当前数组，保持活数组身份语义（非快照）。
  all() { return this._store.instances; }
  forEach(fn) { return this._store.instances.forEach(fn); }
  find(id) { return this._store.instances.find((i) => i.id === id); }
  map(fn) { return this._store.instances.map(fn); }

  /** 沙箱能力（实时求值）：三平台均可跑舱（W3 portable 档）；保留显式覆写位供测试/嵌入方。 */
  get sandboxSupported() { return sandbox.supported(this._sandboxSupportedOverride); }
  _setSandboxSupportedForTest(v) { this._sandboxSupportedOverride = (v === null ? null : v === true); }

  // 6 个回调访问器（compose.js 直接赋值；内部只读 _hooks）
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

  // 域间契约面（签名与语义逐字保持）。
  load() { return this._store.load(); }
  save() { return this._store.save(); }
  list() { return this._ops.list(); }
  addInstance(payload) { return this._ops.addInstance(payload); }
  removeInstance(id) { return this._ops.removeInstance(id); }
  updateInstance(id, patch) { return this._ops.updateInstance(id, patch); }
  startInstance(id, opts) { return this._lifecycle.start(id, opts); }
  stopInstance(id) { return this._lifecycle.stop(id); }
  supervise(id) { return this._lifecycle.supervise(id); }
  /** 治理单拍（B2-6e）：心跳拍末由 onBeatDone 调一次，全花名册 decide+下发+违规处置。 */
  governSweep() { return this._lifecycle.governSweep(); }
  probeInstance(id) { return this._lifecycle.probeInstance(id); }
  /** 资源预算总览（/env/status 观测面，W2）：当前占用/剩余/下一份保底/可容纳实例数。 */
  budgetSnapshot() { return governor.budgetSnapshot(this._store.instances, this.machineFacts || undefined); }
  checkUpdate(id) { return this._upgrade.checkUpdate(id); }
  upgradeInstance(id) { return this._upgrade.upgradeInstance(id); }
  upgradeStatus(id) { return this._upgrade.upgradeStatus(id); }
  startTimer(ms) { return this._ops.startTimer(ms); }
  sandboxRoot(inst) { return sandbox.root(this.instancesRoot, inst); }
  sandboxDataDir(inst) { return sandbox.dataDir(this.instancesRoot, inst); }
  sandboxInstallDir(inst) { return sandbox.installDir(this.instancesRoot, inst); }
  /** portable 档身份上下文（{port,pidFile,anchors}）：跨模块停止/复核调用点（shutdown）经门面取用，
   *  不自行拼路径——锚点推导与 lifecycle 启停两侧必须同值，否则归属校验失效。systemd 档忽略附加字段。 */
  launchCtx(inst) { return sandbox.launchCtx(this.instancesRoot, this.dshBin, inst); }
  _prepareSystemd() { return this._lifecycle._prepareSystemd(); }
}

module.exports = { InstanceManager };
