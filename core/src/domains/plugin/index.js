'use strict';

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
    this.instances = opts.instances || null;
    this.onNativeRestart = opts.onNativeRestart || null;
    this.exitIntended = typeof opts.exitIntended === 'function' ? opts.exitIntended : () => false;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;
    this.tasks = opts.tasks || null;
    this._updCache = {};
    this._updTTL = 6 * 3600 * 1000;
    this._updSnapshot = null;
    this._updInFlight = null;
    this.jobs = createJobs({ tasks: this.tasks });
    this.layers = createLayers({ overlayFile: this.overlayFile, logger: this.logger });
    this.store = new store.PluginStore({ getInventory: () => this.inventory() });
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
