'use strict';

// 原生 agent 适配器：把 AgentManager 包装成 API 层熟悉的 nativeManager 形状。
//
// 为什么需要它：api/domains/native.js 与 guard.js 消费 sup.nativeManager 的 9 个方法
//（status / versionInfo / upgradeStatus / checkUpdate / startInstall / upgrade /
// busy / startUninstall / upgradeState）。直接用 AgentManager 替换会改到 API 层，
// 而 API 层还有大量与 agent 无关的路由——混在一起改无法分别验证。
//
// 适配器只做形状翻译，**不放业务逻辑**：所有判定都委托 AgentManager / ops.*，
// 这里唯一的新增是把「原生 agent」这个具体形态的 prefix / 包名 / hooks 装配出来。
//
// 这是迁移期组件：API 切到 agent 域后即可删除（见 ops/README.md 的迁移步骤）。

const path = require('node:path');
const status = require('./status');
const entryOps = require('./ops/entry');

const NATIVE_ID = 'main';

class NativeAgentAdapter {
  constructor(opts) {
    this.agents = opts.agents;
    this.config = opts.config;
    this.dist = opts.dist || null;
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.tasks = opts.tasks || null;
    this.hooks = opts.hooks || {};
    this.npmRoot = opts.npmRoot || null;

    // 原生 agent 的记录：固定 id，包名来自配置。
    this.agent = {
      id: NATIVE_ID,
      product: this.config && this.config.packageName ? this.config.packageName : null,
      kind: 'native',
      port: this._targetPort() || 0,
    };

    // 升级状态机：与旧 nativeManager 同形（API 直接读 upgradeState）。
    this.upgradeState = 'idle';
    this.oldVersion = null;
    this.targetVersion = null;
    this.upgradeStartedAt = null;
    this.upgradeFinishedAt = null;
    this.upgradeError = null;
    this.rolledBack = false;
    this.upgradeLog = [];
    this.lastCheck = null;
    this.checkingNow = false;
    this.installing = null;
    this.uninstalling = null;
    this.installLog = [];
    this.lastInstall = null;
    this.lastUninstall = null;
  }

  // ---- 包名与 prefix ----
  _pkg() { return (this.config && this.config.packageName) || this.agent.product || null; }
  _prefix() { return this.npmRoot || null; }

  _log(m) { if (this.logger && this.logger.info) this.logger.info(m); }
  _warn(m) { if (this.logger && this.logger.warn) this.logger.warn(m); }

  // ---- 探测 ----
  detected() {
    try {
      const cands = entryOps.nativeCandidates({ npmRoot: this.npmRoot, dshBin: this._dshBin() });
      return cands.length ? { bin: cands[0] } : null;
    } catch { return null; }
  }

  _dshBin() {
    return (this.config && Array.isArray(this.config.command) && this.config.command[1])
      ? this.config.command[1]
      : 'dsh';
  }

  binPath() {
    const d = this.detected();
    return (d && d.bin) || this._dshBin() || null;
  }

  installedVersion() {
    const installOps = require('./ops/install');
    return installOps.installedVersionAt(this._prefix(), this._pkg());
  }

  // ---- 状态投影（API 直接消费）----
  status() {
    const installed = this.installedVersion();
    return {
      installed: !!installed,
      version: installed || null,
      bin: this.binPath(),
      npmRoot: this.npmRoot,
      busy: this.busy(),
      state: this.upgradeState,
    };
  }

  versionInfo() {
    return status.versionInfo(this, this.installedVersion());
  }

  upgradeBrief() { return status.upgradeBrief(this); }

  upgradeStatus() {
    return Object.assign({}, status.upgradeBrief(this), { logTail: this.upgradeLog.slice(-40) });
  }

  busy() { return status.busy(this); }

  checkEnvironment() {
    const installOps = require('./ops/install');
    const rc = require('../../platform/contract/runtime');
    return installOps.checkEnvironment(rc.npmLauncher());
  }

  _targetPort() {
    const cfg = this.config || {};
    const direct = Number(cfg.targetPort);
    if (Number.isInteger(direct) && direct > 0) return direct;
    try { return Number(new URL(cfg.healthUrl).port) || null; } catch { return null; }
  }

  // ---- 更新检查 ----
  async checkUpdate() {
    this.checkingNow = true;
    try {
      const r = await this.agents.checkUpdate(this.agent, {
        dist: this.dist,
        npmRoot: this.npmRoot,
        installed: this.installedVersion(),
      });
      this.lastCheck = {
        installed: r.installed || null,
        latest: r.latest || null,
        updateAvailable: !!r.updateAvailable,
        at: new Date().toISOString(),
        error: r.error || null,
      };
      return r;
    } finally { this.checkingNow = false; }
  }

  // ---- 安装 ----
  async install(version) {
    this.installing = version || null;
    try {
      const r = await this.agents.install(this.agent, {
        dist: this.dist,
        npmRoot: this.npmRoot,
        version: version || null,
        registry: await this._selectRegistry(),
        log: (m) => this.installLog.push(m),
      });
      this.lastInstall = {
        ok: r.ok,
        version: r.ok ? (this.installedVersion() || version || null) : null,
        error: r.ok ? null : (r.error || null),
        at: new Date().toISOString(),
        log: this.installLog.slice(-8),
      };
      if (r.ok && this.events) {
        try { this.events.append('native_installed', { version: this.lastInstall.version }); } catch {  }
      }
      if (!r.ok && this.events) {
        try { this.events.append('native_install_failed', { error: r.error }); } catch {  }
      }
      return r;
    } finally { this.installing = null; }
  }

  startInstall(version) {
    const gate = status.assertNotBusy(this, 'install');
    if (gate) return gate;
    if (!status.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
    this.install(version).then(() => {}).catch((e) => {
      this.installing = null;
      this._warn('native install crashed: ' + ((e && e.message) || e));
    });
    return { ok: true, started: true };
  }

  // ---- 升级（委托 AgentManager.upgrade，env 在此装配）----
  async upgrade(requestedVersion) {
    if (!status.isValidVersion(requestedVersion)) return { ok: false, error: '非法版本号: ' + requestedVersion };
    const oldV = this.installedVersion();
    this.oldVersion = oldV;
    this.upgradeState = 'installing';
    this.upgradeStartedAt = new Date().toISOString();
    this.upgradeFinishedAt = null;
    this.upgradeError = null;
    this.rolledBack = false;
    this.upgradeLog = [];
    this.targetVersion = requestedVersion || null;

    const env = {
      installedVersion: () => this.installedVersion(),
      latestVersion: async () => {
        const installOps = require('./ops/install');
        const resolver = installOps.createLatestResolver(this.dist, {});
        return resolver(this._pkg());
      },
      install: async (v, registry) => this.agents.install(this.agent, {
        dist: this.dist, npmRoot: this.npmRoot, version: v, registry: registry || null,
      }),
      selectRegistry: () => this._selectRegistry(),
      recordManifest: async () => {},
      isActive: () => !!(this.hooks.isDshActive && this.hooks.isDshActive()),
      stopForUpgrade: async () => { if (this.hooks.stopForUpgrade) await this.hooks.stopForUpgrade(); },
      resume: async () => { if (this.hooks.resumeAfterUpgrade) await this.hooks.resumeAfterUpgrade(); },
      desiredRunning: () => !!(this.hooks.desiredRunning && this.hooks.desiredRunning()),
      waitHealthy: async (port, ms) => {
        if (this.hooks.waitNativeHealthy) return this.hooks.waitNativeHealthy(port, ms);
        const rc = require('../../platform/contract/runtime');
        return { ok: false, reason: 'waitNativeHealthy 未提供' };
      },
      targetPort: () => this._targetPort(),
      mainUnit: () => null,
      notify: (t, b) => { if (this.hooks.notify) this.hooks.notify(t, b); },
      verifyDeadlineMs: () => (this.hooks.verifyDeadlineMs ? this.hooks.verifyDeadlineMs() : 120000),
      log: (m) => this.upgradeLog.push(m),
      events: this.events,
      tasks: this.tasks,
    };

    const r = await this.agents.upgrade(this.agent, { env, dist: this.dist, npmRoot: this.npmRoot });
    this.upgradeFinishedAt = new Date().toISOString();
    this.upgradeError = r.ok ? null : (r.error || null);
    this.upgradeState = r.ok ? 'done' : 'failed';
    this.rolledBack = !!(r.error && /已回滚/.test(r.error));
    return r;
  }

  // ---- 卸载 ----
  async uninstall() {
    const gate = status.assertNotBusy(this, 'uninstall');
    if (gate) return gate;
    this.uninstalling = true;
    try {
      const r = await this.agents.uninstall(this.agent, {
        dist: this.dist,
        npmRoot: this.npmRoot,
        safeAncestors: this.npmRoot ? [this.npmRoot] : [],
        extraPaths: [],
        isActive: () => !!(this.hooks.isDshActive && this.hooks.isDshActive()),
        stop: async () => { if (this.hooks.stopForUpgrade) await this.hooks.stopForUpgrade(); },
        state: this,
        events: this.events,
      });
      this.lastUninstall = {
        ok: r.ok,
        removed: r.removed || [],
        error: r.ok ? null : (r.error || null),
        at: new Date().toISOString(),
      };
      return r;
    } finally { this.uninstalling = null; }
  }

  startUninstall() {
    const gate = status.assertNotBusy(this, 'uninstall');
    if (gate) return gate;
    this.uninstall().then(() => {}).catch((e) => {
      this.uninstalling = null;
      this._warn('native uninstall crashed: ' + ((e && e.message) || e));
    });
    return { ok: true, started: true };
  }

  async _selectRegistry() {
    if (!this.dist) return null;
    try { return await this.dist.registryOrigin(true); } catch { return null; }
  }
}

module.exports = { NativeAgentAdapter, NATIVE_ID };
