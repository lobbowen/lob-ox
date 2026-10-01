'use strict';

const policies = require('./policies');
const release = require('./release');
const registryConfig = require('./registry-config');
const registry = require('./registry');
const versionCheck = require('./version-check');
const install = require('./install');
const { semverCompare, VERSION_RE } = require('../../shared/version');

class DistributionManager {
  constructor(opts) {
    opts = opts || {};
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.registryFile = opts.registryFile || null;
    this.choiceFile = opts.registryChoiceFile || null;
    this.defaultRegistries = (opts.registries && opts.registries.length) ? opts.registries : [...policies.FALLBACK_REGISTRIES];
    this.contract = { ok: false, reason: 'not-loaded', catalog: [], probe: null, measurements: [], legacyChoice: null };
    this.registryConfig = { mode: 'auto', manualOrigin: '', origins: [] };
    this.canary = opts.canary === true;
    this.selectedRegistry = null;
    registryConfig.loadRegistryConfig(this);
    this._contractLoadedAt = Date.now();
  }

  _reloadContractIfStale() { registryConfig.reloadContractIfStale(this); }
  _loadRegistryConfig() { registryConfig.loadRegistryConfig(this); }
  _saveRegistryConfig() { registryConfig.saveRegistryConfig(this); }
  _platformTag() { return registry.platformTag(); }
  _probeRegistry(origin) { return registry.probeRegistry(this, origin); }
  probeOrigin(origin) { return registry.probeOrigin(this, origin); }
  _registryOrigins() { return registry.registryOrigins(this); }
  selectRegistry(force) { return registry.selectRegistry(this, force); }
  registryOrigin(force) { return registry.registryOrigin(this, force); }
  registryInfo() { return registry.registryInfo(this); }
  setRegistryConfig(cfg) { return registry.setRegistryConfig(this, cfg); }
  _inCanaryList() { return policies.isInCanaryList(this); }

  fetchNpmLatest(pkg, opts) { return versionCheck.fetchNpmLatest(this, pkg, opts); }
  fetchVersionInfo(pkg, channel, opts) { return versionCheck.fetchVersionInfo(this, pkg, channel, opts); }
  fetchLatestVersion(pkg, channel, opts) { return versionCheck.fetchLatestVersion(this, pkg, channel, opts); }
  runNpmInstall(opts) { return install.runNpmInstall(opts); }
  waitPortHealthy(opts) { return install.waitPortHealthy(opts); }
}

module.exports = {
  DistributionManager,
  semverCompare,
  VERSION_RE,
  pickReleaseVersion: release.pickReleaseVersion,
  isOurReleasePackage: release.isOurReleasePackage,
  OUR_RELEASE_SCOPE: release.OUR_RELEASE_SCOPE,
  ROLLBACK_FLOOR_VERSION: release.ROLLBACK_FLOOR_VERSION,
  ROLLBACK_MAX_AGE_DAYS: release.ROLLBACK_MAX_AGE_DAYS,
  killInflightNpm: install.killInflightNpm,
  inflightNpmCount: install.inflightNpmCount,
};
