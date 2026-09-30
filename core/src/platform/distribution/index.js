'use strict';

// 统一的「包发布/安装/更新」平台能力，归 platform/，与 platform/contract、platform/os 同层（消费者横跨 root/daemon/instance）。
// 本文件是薄门面，只做组合与导出，不含算法/IO：
//   registry-ref.js 镜像基址的定义与传输单口、release.js 选版（纯）、policies.js 纯策略、
//   registry-config.js 两份镜像文件的载入与落盘（契约只读、选择文档只由内核写）、registry.js 探测与选源（IO）、
//   version-check.js 目标版本查询（IO）、install.js npm 安装执行 + 端口健康验证（IO）。

const policies = require('./policies');
const release = require('./release');
const registryConfig = require('./registry-config');
const registry = require('./registry');
const versionCheck = require('./version-check');
const install = require('./install');
// semver 合法性与比较器的唯一实现在 shared/version.js。
const { semverCompare, VERSION_RE } = require('../../shared/version');

/** 统一分发管理器：门面。状态字段由本实例持有，实现函数显式收参（零跨文件 this）。
 *  @param opts - registries: 候选镜像源兜底（默认来自 config.registries）；registryFile: 壳投放的镜像契约
 *  （只读）；registryChoiceFile: 内核自持的选择文档（唯一写者，见 registry-config.js 的所有权说明）；
 *  events / logger；canary: 本机灰度事实（默认 false） */
class DistributionManager {
  constructor(opts) {
    opts = opts || {};
    this.events = opts.events || null;
    this.logger = opts.logger || console;
    this.registryFile = opts.registryFile || null;
    this.choiceFile = opts.registryChoiceFile || null;
    // 最小兜底（仅契约不可用时用；见 policies.FALLBACK_REGISTRIES）。
    this.defaultRegistries = (opts.registries && opts.registries.length) ? opts.registries : [...policies.FALLBACK_REGISTRIES];
    // 壳投放的镜像契约（目录 + 探测规格 + 壳本轮测速证据）。
    this.contract = { ok: false, reason: 'not-loaded', catalog: [], probe: null, measurements: [], legacyChoice: null };
    // 内核自持的选择：mode auto|manual，manualOrigin 手动固定，origins 用户在面板里显式维护的候选
    // （空=不覆盖壳目录）。落盘只写 choiceFile。
    this.registryConfig = { mode: 'auto', manualOrigin: '', origins: [] };
    // 灰度事实：组装根注入「本机配置 canary:true / DSH_CANARY=1」。
    this.canary = opts.canary === true;
    this.selectedRegistry = null; // { origin, ordered, source, manual, checkedAt, latencyMs, probes }
    // 注意：必须同时记「刚载入」时刻，否则首次 _reloadContractIfStale 会把 undefined 当成「从未载入」。
    registryConfig.loadRegistryConfig(this);
    this._contractLoadedAt = Date.now();
  }

  // ---- 镜像源（registry-config.js 载入/落盘，registry.js 探测/选源）----
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

  // ---- 版本检查 / 安装 / 健康（version-check.js + install.js）----
  // fetchNpmLatest 回 npm 通道的结构化结果（含给出该版本的 origin 与逐源原因）。
  // fetchVersionInfo 是**跨通道**的结构化口（npm|github，github 的 origin 恒 null）；
  // fetchLatestVersion 只回版本字符串，只要版本号的调用方走它。
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
  // 选版算法（release.js 唯一实现）+ 包归属判定 + rollback 防降级下限常量（RC-7）
  pickReleaseVersion: release.pickReleaseVersion,
  isOurReleasePackage: release.isOurReleasePackage,
  OUR_RELEASE_SCOPE: release.OUR_RELEASE_SCOPE,
  ROLLBACK_FLOOR_VERSION: release.ROLLBACK_FLOOR_VERSION,
  ROLLBACK_MAX_AGE_DAYS: release.ROLLBACK_MAX_AGE_DAYS,
  // 在途 npm 中止出口（D-10）：句柄登记在 install.js 的模块级集合（跨实例、覆盖全部调用路径），
  // 故门面按静态导出而非实例方法——挂实例会漏掉直接 require('./install') 的调用方。
  killInflightNpm: install.killInflightNpm,
  inflightNpmCount: install.inflightNpmCount,
};
