'use strict';

// 反代供应商：账号=代理实例（一账号一实例硬规则）。process-pool 契约方法（启停/重启/熔断/对账）在 mixin；
// 本文件留 ctor 与委托：命令拼装 command.js、期望集纯决策 pool.js、spawn/探活/配额探测 probe.js、
// 重启重拉/对账 restart.js、冻结状态机 base.js 与 freeze.js。

const { ProviderBase } = require('./base');
const { withProcessPool } = require('./process-pool');
const { keyFingerprint, maskKey } = require('./model');
const { ProxyInstance } = require('../model');
require('../port-segments'); // 本域端口段/独立池申报（require 即注入）
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
    this.stateDir = opts.stateDir || null; // 数据目录（config.stateFile 派生）：日志落这里
    this.proxyRunning = false;
    this.instances = [];
    this.selectedAccountKeyId = null;
    this._prewarmKeyId = null; // 预热槽 sticky 归属（内存）：只在占用者自身失效/被提为在用时让位
    this._startLock = false; // 实例启动互斥：一次只 spawn 一个 npx
    this._stopping = false; // 关停标记：stop() 前置真，期间不预启动
    this._terminatingPids = new Set(); // 停服台账：已发 SIGTERM 的子进程 pid
  }

  async ensureInstance(key) {
    let inst = this.instances.find((i) => i.key === key);
    if (inst) return inst;
    inst = new ProxyInstance({ key, keyId: keyFingerprint(key), maskedKey: maskKey(key), app: this.app, logger: this.logger, events: this.events });
    this.instances.push(inst);
    return inst;
  }

  /** 解析启动命令（缓存优先 + fallback npx）：拼装委托 command.js；凭证剔除留在本层（纪律）。 */
  async _resolveLaunchCommand(app, port, key) {
    const registry = this.dist ? await this.dist.registryOrigin(false).catch(() => null) : null;
    const cachedBin = this._cachedPkgBin(app.pkg);
    // npx 兜底必须成对 launcher 形态（node 直启 npx-cli.js 优先）：win32 无 shell spawn .cmd 必 EINVAL。
    const launch = buildCommand({ app, port, cachedBin, registry, launcher: npxLauncher(), execPath: process.execPath });
    if (!launch || !launch.ok) return launch || { ok: false, error: '命令拼装失败' };
    // 凭证纪律：key 只经 env（app.keyEnv），argv 必须剔除 --api-key 及其值与 {{key}} 占位
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

  /** 429/403 配额冻结：先立即回收进等待区（force + 释放端口，零宽限），再状态机，再对账补槽。 */
  markQuotaExhausted(acc, cooldownMs) {
    this.reclaimAccount(acc);
    super.markQuotaExhausted(acc, cooldownMs);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  /** credits 余额不足：与窗口同一处置（回收 + 冻结 + 补槽）。 */
  markCreditsExhausted(acc) {
    this.reclaimAccount(acc);
    super.markCreditsExhausted(acc);
    this.reconcileNow();
    this._probeAfterResponseFreeze(acc);
  }

  _probeAfterResponseFreeze(acc) { return probe.probeAfterResponseFreeze(this, acc); }

  // 期望集（纯决策在 pool.js；此处读 provider 状态并落预热槽 sticky 归属）
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

  /** 封号：与配额冻结同一处置（先回收再走状态机）。 */
  markBanned(acc, error) {
    this.reclaimAccount(acc);
    super.markBanned(acc, error);
  }
}

module.exports = { ProxyProvider };
