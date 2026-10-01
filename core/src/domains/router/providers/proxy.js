'use strict';

const { ProviderBase } = require('./base');
const { withProcessPool } = require('./process-pool');
const { keyFingerprint, maskKey } = require('./model');
const { ProxyInstance } = require('../model');
require('../port-segments');
const { npxLauncher } = require('../../../platform/os/npx-forms');
const { buildCommand } = require('./command');
const probe = require('./probe');
const restart = require('./restart');
const pool = require('./pool');
const life = require('./instance-lifecycle');

class ProxyProvider extends withProcessPool(ProviderBase) {
  constructor(opts) {
    super(opts);
    this.kind = 'proxy';
    this.proxyAppId = opts.proxyAppId;
    this.app = opts.app || null;
    this.stateDir = opts.stateDir || null;
    this.proxyRunning = false;
    this.instances = [];
    this.selectedAccountKeyId = null;
    this._prewarmKeyId = null;
    this._startLock = false;
    this._stopping = false;
    this._terminatingPids = new Set();
  }

  async ensureInstance(key) {
    let inst = this.instances.find((i) => i.key === key);
    if (inst) return inst;
    inst = new ProxyInstance({ key, keyId: keyFingerprint(key), maskedKey: maskKey(key), app: this.app, logger: this.logger, events: this.events });
    this.instances.push(inst);
    return inst;
  }

  async _resolveLaunchCommand(app, port, key) {
    const registry = this.dist ? await this.dist.registryOrigin(false).catch(() => null) : null;
    const cachedBin = this._cachedPkgBin(app.pkg);
    const launch = buildCommand({ app, port, cachedBin, registry, launcher: npxLauncher(), execPath: process.execPath });
    if (!launch || !launch.ok) return launch || { ok: false, error: '命令拼装失败' };
    const cmd = [];
    for (let i = 0; i < launch.cmd.length; i++) {
      const t = launch.cmd[i];
      if (t === '--api-key') { i++; continue; }
      if (String(t).includes('{{key}}')) continue;
      cmd.push(t);
    }
    return { ok: true, cmd, registry: launch.registry };
  }

  _cachedPkgBin(pkg) { return probe.cachedPkgBin(pkg); }
  _ensurePkgCached(app) { return probe.ensurePkgCached(this, app); }

  _canStopInstance(acc) { return life.canStopInstance(this, acc); }

  async waitAllStopped(timeoutMs) { return probe.waitAllStopped(this, timeoutMs); }

  async healthInstance(inst) { return probe.healthInstance(this, inst); }

  async monitorLifecycle() { return probe.monitorLifecycle(this); }

  async detectInstanceQuota(inst) { return probe.detectInstanceQuota(this, inst); }

  async addAccount(key, extra) { return life.addAccount(this, key, extra); }
  isAccountUsable(acc, opts) { return life.isAccountUsable(this, acc, opts); }

  markQuotaExhausted(acc, cooldownMs) {
    this.reclaimAccount(acc);
    super.markQuotaExhausted(acc, cooldownMs);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  markCreditsExhausted(acc) {
    this.reclaimAccount(acc);
    super.markCreditsExhausted(acc);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  _probeAfterResponseFreeze(acc) { return probe.probeAfterResponseFreeze(this, acc); }

  desiredRunningAccounts() {
    const r = pool.computeDesired({
      accounts: this.accounts,
      selectedAccountKeyId: this.selectedAccountKeyId,
      activeKeyId: this.activeAccount && this.activeAccount.keyId,
      prewarmKeyId: this._prewarmKeyId,
      isUsable: (a) => this.isAccountUsable(a),
    });
    this._prewarmKeyId = r.prewarm ? r.prewarm.keyId : null;
    return r;
  }
  isDesiredAccount(acc) { return pool.isDesired(this.desiredRunningAccounts().list, acc); }

  _runReconcile(allowStop) { return restart.runReconcile(this, allowStop); }
  reconcileNow() { return restart.reconcileNow(this); }

  markBanned(acc, error) {
    this.reclaimAccount(acc);
    super.markBanned(acc, error);
  }
}

module.exports = { ProxyProvider };
