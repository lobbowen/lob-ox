'use strict';

// 插件域门面（组合根 + 导出）。域内单向分层：model/policies（纯）-> targets/cli/store（叶子 IO）-> layers（写队列）-> jobs
// -> restart -> ops/updater（编排）-> index；jobs 对 ops 零出边、store.listInstalled 收 targets 入参以消除反向边。组合手法：构造期创建 jobs/layers，其余经 ctx 显式传入。
// 门面保留同名可覆盖转发方法（resolveTargets/installedOn/_runCli/_setBundleEnabledInner/_scrubPluginLayersInner 等）：既有测试以实例属性桩替换这些名字，改名即断。

const { PROTECTED } = require('./model');
const store = require('./store');
const targets = require('./targets');
const cli = require('./cli');
const restart = require('./restart');
const { createJobs } = require('./jobs');
const { createLayers } = require('./layers');
const ops = require('./ops');
const updater = require('./updater');
const { PluginMarket } = require('./market');

class PluginManager {
  constructor(opts) {
    this.dshBin = opts.dshBin || 'dsh';
    this.profileName = opts.profileName || 'web';
    this.profileDir = opts.profileDir;
    this.overlayFile = opts.overlayFile;
    this.dshPort = opts.dshPort;
    this.instances = opts.instances || null;   // InstanceManager（实例目标数据源）
    this.onNativeRestart = opts.onNativeRestart || null; // 原生 DSH 重启回调（supervisor 注入）
    // INV-S1 退出门谓词（守卫注入 host._exitIntended，E-3 单源）。
    //   本域注入裸 InstanceManager，门不在域方法上 —— 变更生效路径必须自查，防退出中拉起实例。
    this.exitIntended = typeof opts.exitIntended === 'function' ? opts.exitIntended : () => false;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;
    this.tasks = opts.tasks || null;           // 统一安装/更新任务注册表
    this._updCache = {};                       // 插件更新检测缓存：name -> { latest, at }（TTL 6h）
    this._updTTL = 6 * 3600 * 1000;
    this._updSnapshot = null;                  // 最近一次检测结果快照 { checkedAt, plugins, error }
    this._updInFlight = null;                  // 在飞检测 promise（去重：force 连点不叠加）
    this.jobs = createJobs({ tasks: this.tasks });                          // 作业表 + 作用域互斥
    this.layers = createLayers({ overlayFile: this.overlayFile, logger: this.logger }); // 补丁层写队列
    this.store = new store.PluginStore({ getInventory: () => this.inventory() });       // 补丁行 id 推导
  }

  resolveTargets(str) { return targets.resolveTargets(this, str); }
  _nativeTarget() { return targets.nativeTarget(this); }
  _sandboxTarget(inst) { return targets.sandboxTarget(this, inst); }
  _allSandboxTargets() { return targets.allSandboxTargets(this); }

  installedOn(target) { return store.installedOn(target, PROTECTED); }
  inventory() { return store.inventory(this.dshPort); }
  readManifest() { return store.readManifest(this.profileDir); }
  overlayEntries() { return store.overlayEntries(this.overlayFile); }
  listInstalled() { return ops.listInstalled(this); }

  // 补丁层（可覆盖转发；队列/内层在 layers 服务）
  setBundleEnabled(name, on, targetStr) {
    return this.layers.enqueue('setBundleEnabled', () => this._setBundleEnabledInner(name, on, targetStr));
  }
  _setBundleEnabledInner(name, on, targetStr) { return this.layers.applyBundleEnabled(this, name, on, targetStr); }
  _scrubPluginLayers(target, name, onLog) {
    return this.layers.enqueue('scrub', () => this._scrubPluginLayersInner(target, name, onLog));
  }
  _scrubPluginLayersInner(target, name, onLog) { return this.layers.scrubPluginLayersInner(this, target, name, onLog); }
  _removeFromProfileBundles(target, pluginName) { return this.layers.removeFromProfileBundles(target, pluginName); }
  _readHomePatch(target) { return store.readHomePatch(target); }
  _writeHomePatch(target, entries) { return this.layers.writeHomePatch(target, entries); }
  saveOverlayEntries(entries) { return this.layers.saveOverlayEntries(entries); }

  _runCli(target, args, opts) {
    return cli.runCli({ target, args, opts, registryOrigin: () => cli.registryOrigin(this.dist), logger: this.logger });
  }
  _targetRunning(target) { return restart.targetRunning(this, target); }
  _applyPluginChange(target, kind, onLog) { return restart.applyPluginChange(this, target, kind, onLog); }

  install(spec, opts) { return ops.install(this, spec, opts); }
  uninstall(name, targetStr) { return ops.uninstall(this, name, targetStr); }
  installStatus(jobId) { return this.jobs.installStatus(jobId); }
  checkUpdates(force) { return updater.checkUpdates(this, force); }
  update(name, targetStr) { return updater.update(this, name, targetStr); }
}

module.exports = { PluginManager, PluginMarket, PROTECTED };
