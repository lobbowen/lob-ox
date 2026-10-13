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
    // R7/D.12-E-2：原实现靠字符串级过滤剥掉 --api-key 与含 {{key}} 的 token——
    // 这是启发式而非结构保证：模板若写成 ['npx','pkg','--token','{{key}}'] 则 key
    // 直接进 argv。现改为显式断言：拼装结果里出现 key 原值或其常见编码即拒绝启动。
    const cmd = [];
    for (let i = 0; i < launch.cmd.length; i++) {
      const t = launch.cmd[i];
      if (t === '--api-key') { i++; continue; }
      if (String(t).includes('{{key}}')) continue;
      cmd.push(t);
    }
    const keyStr = String(key || '');
    if (keyStr && keyStr.length >= 8) {
      const leak = cmd.find((c) => String(c).includes(keyStr));
      if (leak !== undefined) {
        this.events && this.events.append('proxy_instance_key_in_argv_refused', { app: this.proxyAppId, port });
        this.logger && this.logger.error && this.logger.error('[proxy-instance] 拒绝启动：拼装出的 argv 含凭据原值（ps 可见）');
        return { ok: false, error: '拼装出的 argv 含凭据原值，已拒绝启动（凭据禁入 argv）' };
      }
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
