'use strict';

// 原生 DeepSeek Harness（原生 DSH）生命周期门面——组合 + 委托，无业务实现。
// 公共导出面 NativeManager 的消费方：supervisor、api/domains/native、assembly/compose、
//   app/settings/versions 等门面装配入口。

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
    this.dist = opts.dist || null;          // 统一分发：镜像源适配 + 版本获取
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.stateDir = opts.stateDir;          // 守卫状态目录（默认 <产品状态根>/supervisor）
    this.manifestFile = path.join(this.stateDir, 'native-manifest.json');
    this.dshHome = path.join(os.homedir(), '.dsh'); // DSH 数据目录（与守卫状态目录分开）
    this.npmRoot = opts.npmRoot || null;    // npm 全局根（测试可注入隔离目录）
    // npm 启动形态的注入口（构造期依赖注入，生产留空 = 走运行期契约/平台解析）。
    // 解构 require 是值绑定、patch 无效，故做成构造期可注入，结构上保证测试不触碰真实 npm。
    // 注入即接管整对（见 npm.npmLaunch 说明）。
    this._npmBin = opts.npmBin || null;
    this._npmBinArgs = opts.npmBinArgs || null; // 前置参数（以 node 执行包内 JS 的形态）
    this.hooks = opts.hooks || {};          // 守卫生命周期钩子（升级停/起 DSH 时回调）
    this.tasks = opts.tasks || null;        // 统一安装/更新任务注册表
    // 升级状态机字段（idle | installing | restarting | verifying | rolling_back | done | failed）
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

  /** 追加安装输出（有界，仅任务进行中由 _runNpm 的行日志写入）。 */
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
  /** npm 动作的唯一出口（装/升/回滚/卸载同源），入参见 npm.runNpm。 */
  _runNpm(opts) { return npm.runNpm(this, opts); }
  /** 最新版本 + 给出它的那个镜像源（结构化，回 {ok,version,origin,error}）。 */
  _latestVersion() { return npm.latestVersion(this); }
  /** 只选源（钉死版本的安装与回滚用）；查询过版本的安装路径走 _latestVersion 的 origin。 */
  _selectRegistry() { return npm.selectRegistry(this); }
  _waitNativeHealthy(port, unit, timeoutMs) { return probe.waitNativeHealthy(this, port, unit, timeoutMs); }
  _targetPort() { return probe.targetPort(this.config); }
  _mainUnit() { return probe.mainUnit(); }
  busy() { return policies.busy(this); }
  upgradeBrief() { return policies.upgradeBrief(this); }
  upgradeStatus() { return { ...policies.upgradeBrief(this), logTail: this.upgradeLog.slice(-40) }; }

  /** 安装（统一任务模型）。前置互斥检查在此（同步、先于任何 await）。 */
  async install(version) {
    if (this.tasks && this.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
    if (this.installing) return { ok: false, error: '安装已在进行中' };
    if (this.uninstalling) return { ok: false, error: '卸载进行中，请稍后再装' };
    if (this.busy()) return { ok: false, error: '升级进行中，请稍后再装（state=' + this.upgradeState + '）' };
    return ops.install(this, version);
  }

  startInstall(version) { return ops.startInstall(this, version); }

  /** 一键升级（先停后装、验证、失败回滚）。前置互斥检查在此。 */
  async upgrade(requestedVersion) {
    if (this.tasks && this.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
    if (this.busy()) return { ok: false, error: 'upgrade already in progress (state=' + this.upgradeState + ')' };
    if (this.installing) return { ok: false, error: '安装/升级已在进行中' };
    if (this.uninstalling) return { ok: false, error: '卸载进行中，请稍后再试' };
    return upgradeOps.upgrade(this, requestedVersion);
  }

  startUninstall() { return ops.startUninstall(this); }

  /** 异步卸载（全量清理，不留残留）。前置互斥检查在此。 */
  async uninstall() {
    if (this.tasks && this.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
    if (this.installing) return { ok: false, error: '安装进行中，无法卸载' };
    if (this.uninstalling) return { ok: false, error: '卸载已在进行中' };
    if (this.busy()) return { ok: false, error: '升级进行中，无法卸载（state=' + this.upgradeState + '）' };
    return ops.uninstall(this);
  }
}

module.exports = { NativeManager };
