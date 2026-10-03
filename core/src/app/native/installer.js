'use strict';

const path = require('node:path');
const os = require('node:os');
const policies = require('./policies');
const probe = require('./probe');
const manifest = require('./manifest');
const npm = require('./npm');
const ops = require('./ops');
const upgradeOps = require('./upgrade');

class NativeManager {
  constructor(opts) {
    this.config = opts.config;
    this.dist = opts.dist || null;
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.stateDir = opts.stateDir;
    this.manifestFile = path.join(this.stateDir, 'native-manifest.json');
    this.dshHome = path.join(os.homedir(), '.dsh');
    this.npmRoot = opts.npmRoot || null;
    this._npmBin = opts.npmBin || null;
    this._npmBinArgs = opts.npmBinArgs || null;
    this.hooks = opts.hooks || {};
    this.tasks = opts.tasks || null;
    this.upgradeState = 'idle';
    this.oldVersion = null;
    this.targetVersion = null;
    this.upgradeStartedAt = null;
    this.upgradeFinishedAt = null;
    this.upgradeError = null;
    this.rolledBack = false;
    this.upgradeLog = [];
    this.checkingNow = false;
    this.lastCheck = null;
    this.installing = null;
    this.uninstalling = null;
    this.installLog = [];
    this.lastInstall = null;
    this.lastUninstall = null;
  }

  _appendInstallLog(line) {
    this.installLog.push(line);
    if (this.installLog.length > 60) this.installLog.splice(0, this.installLog.length - 60);
  }

  _appendUpgradeLog(line) {
    const ts = new Date().toISOString().slice(11, 19);
    this.upgradeLog.push('[' + ts + '] ' + line);
    if (this.upgradeLog.length > 60) this.upgradeLog.splice(0, this.upgradeLog.length - 60);
  }

  detected() { return probe.detected(this); }
  binPath() { return probe.binPath(this); }
  installedVersion() { return probe.installedVersion(this); }
  status() { return ops.status(this); }
  versionInfo() { return policies.versionInfo(this, probe.installedVersion(this)); }
  checkUpdate() { return ops.checkUpdate(this); }
  checkEnvironment() { return npm.checkEnvironment(this); }
  _manifest() { return manifest.read(this); }
  _saveManifest(m) { return manifest.save(this, m); }
  async _recordManifest(version, dataPaths) {
    return manifest.record(this, version, dataPaths, this.npmRoot || await npm.resolveNpmRoot(this));
  }
  _claimDataPaths() { return manifest.claimDataPaths(this); }
  _runNpm(opts) { return npm.runNpm(this, opts); }
  _latestVersion() { return npm.latestVersion(this); }
  _selectRegistry() { return npm.selectRegistry(this); }
  _waitNativeHealthy(port, unit, timeoutMs) { return probe.waitNativeHealthy(this, port, unit, timeoutMs); }
  _targetPort() { return probe.targetPort(this.config); }
  _mainUnit() { return probe.mainUnit(); }
  busy() { return policies.busy(this); }
  upgradeBrief() { return policies.upgradeBrief(this); }
  upgradeStatus() { return { ...policies.upgradeBrief(this), logTail: this.upgradeLog.slice(-40) }; }

  async install(version) {
    const g = policies.assertNotBusy(this, 'install');
    if (g) return g;
    return ops.install(this, version);
  }

  startInstall(version) { return ops.startInstall(this, version); }

  async upgrade(requestedVersion) {
    const g = policies.assertNotBusy(this, 'upgrade');
    if (g) return g;
    return upgradeOps.upgrade(this, requestedVersion);
  }

  startUninstall() { return ops.startUninstall(this); }

  async uninstall() {
    const g = policies.assertNotBusy(this, 'uninstall');
    if (g) return g;
    return ops.uninstall(this);
  }
}

module.exports = { NativeManager };
