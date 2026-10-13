'use strict';

// 原生 agent 适配器：把 AgentManager 包装成 API 层熟悉的 nativeAgent 形状。
//
// 为什么需要它：api/domains/native.js 与 guard.js 消费 sup.nativeAgent 的 9 个方法
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
const execUtil = require('../../platform/util/exec');
const runtimeContract = require('../../platform/contract/runtime');

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
    this._npmRootCache = undefined;   // npm root -g 的惰性解析结果

    // 原生 agent 的记录：固定 id，包名来自配置。
    this.agent = {
      id: NATIVE_ID,
      product: this.config && this.config.packageName ? this.config.packageName : null,
      kind: 'native',
      port: this._targetPort() || 0,
    };

    // 升级状态机：与旧 nativeAgent 同形（API 直接读 upgradeState）。
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
  _prefix() {
    if (this.npmRoot) return this.npmRoot;
    return this._npmRootCache || null;   // install 时解析过就有值
  }

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

  // npm 全局前缀。旧实现（app/native/npm.js 的 resolveNpmRoot）在安装时惰性解析，
  // 因为构造期壳往往还没把 node/npm 装好。适配器漏搬了这段，导致 npmRoot=null 时
  // 直接被 agent 域拒绝——「安装 DSH」这个最基础的流程整个断掉（0.0.19 回归）。
  // 行为对齐旧实现：显式 npmRoot 优先，否则 npm root -g 解析；解析不到才报错。
  async _resolveNpmRoot() {
    if (this.npmRoot) return this.npmRoot;
    if (this._npmRootCache !== undefined) return this._npmRootCache;
    const l = runtimeContract.npmLauncher();
    if (!l || !l.program) { this._npmRootCache = null; return null; }
    try {
      const r = await execUtil.runOutAsync(l.program, l.args.concat(['root', '-g']), { timeoutMs: 15000 });
      this._npmRootCache = (r && r.trim()) || null;
    } catch {
      this._npmRootCache = null;
    }
    return this._npmRootCache;
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
      const npmRoot = await this._resolveNpmRoot();
      // 解析成功就固化：后续 installedVersion/status 都靠它，不必再探测。
      if (npmRoot) this.npmRoot = npmRoot;
      // version 缺省 = 装最新。UI（OverviewPage 的安装按钮）走 /native/install 从不带
      // version，旧实现在这条路径上直接返回「非法版本号: null」——按钮从来没通过。
      // 这里解析出 latest 再装，而不是把 null 透传给 dist（那边会报「缺少 version」）。
      let target = version || null;
      if (!target) {
        const installOps = require('./ops/install');
        const resolver = installOps.createLatestResolver(this.dist, {});
        const pick = await resolver(this._pkg());
        target = pick && pick.ok ? pick.version : null;
        if (!target) {
          this.installing = null;
          const why = '无法解析最新版本号（dist 不可用或 registry 查询失败）';
          this.lastInstall = { ok: false, version: null, error: why, at: new Date().toISOString(), log: [] };
          return { ok: false, error: why };
        }
      }
      const r = await this.agents.install(this.agent, {
        dist: this.dist,
        npmRoot,
        version: target,
        registry: await this._selectRegistry(),
        log: (m) => this.installLog.push(m),
      });
      this.lastInstall = {
        ok: r.ok,
        version: r.ok ? (this.installedVersion() || target || null) : null,
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
    // null = 装最新（UI 的默认路径）；给了值才校验格式。
    if (version && !status.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
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

  // 镜像源选择。先试 force（实测各源可达性），拿不到再回退到非 force 的选择。
  // 回退是必需的：契约缺失的降级模式下 force 探测无果会返回 null，
  // 而 npm 拿到 null 就用默认官方源——国内网络下直接挂死到超时，
  // 表现是「安装失败」但没有任何日志（output 为空，超时才被杀）。
  // 镜像源选择。三级回退，缺一级都会让 npm 用默认官方源并挂死到超时：
  //   1. force 探测通过的首个可达源；
  //   2. 非 force 的探测结果（含缓存）；
  //   3. selectRegistry().ordered 的首个候选——探测全部失败时仍要给出一个源，
  //      因为 fetchNpmLatest 本身就是依次尝试 ordered 而不问可达性（它能成功，
  //      说明探测判死不等于真不可用）。npm install 拿不到源就用官方源，
  //      国内网络下表现为「安装失败」且 output 为空、无任何日志。
  // 镜像源选择。四级回退——缺任何一级，npm 都会拿到 null 而用默认官方源，
  // 在访问不了 npmjs.org 的网络上挂死到超时，表现为「安装失败」且无日志。
  //   1. force 探测通过的首个可达源；
  //   2. 非 force 探测结果（含缓存）；
  //   3. selectRegistry().ordered 的首个候选；
  //   4. 复用 fetchNpmLatest 刚刚成功的源——探测机制在契约缺失的降级模式下
  //      全部返回「shell-contract 未提供测速结果」，而 fetchNpmLatest 走的是
  //      「依次尝试、不问可达性」，它能成功说明探测判死不等于真不可用。
  //      这是唯一在降级模式下仍然可靠的源信息，故作为最后兜底。
  // 镜像源选择。回退顺序按「证据强度」排，不是按配置顺序——
  // 配置顺序的首个（npmjs.org）在国内网络下不可达，而探测机制在契约缺失的
  // 降级模式下对所有源都返回「shell-contract 未提供测速结果」，判不出真假。
  // 唯一可靠的证据是 fetchNpmLatest 的实际尝试结果，故它排第一。
  // 少了这一级，npm install 会拿官方源并挂死到超时：表现是「安装失败」，
  // 且 output 为空、无任何日志（超时才被 killTree 杀掉）。
  async _selectRegistry() {
    if (!this.dist) return null;
    // 1. 实测成功过的源（fetchNpmLatest 依次尝试，记录真实可达性）
    try {
      const pick = await this.dist.fetchNpmLatest(this._pkg());
      if (pick && pick.ok && pick.origin) return pick.origin;
    } catch {  }
    // 2/3. 探测结果（含缓存）
    for (const force of [false, true]) {
      try { const o = await this.dist.registryOrigin(force); if (o) return o; } catch {  }
    }
    // 4. 配置顺序兜底
    try {
      const sel = await this.dist.selectRegistry(false);
      const ordered = (sel && sel.ordered) || [];
      if (ordered.length) return ordered[0];
    } catch {  }
    return null;
  }
}

module.exports = { NativeAgentAdapter, NATIVE_ID };
