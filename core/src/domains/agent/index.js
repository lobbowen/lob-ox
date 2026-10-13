'use strict';

// agent 管理域门面。
//
// 定位：内核内所有 agent 产品的统一管理。DSH 是第一个产品，但域不绑定它。
// 五件套（install/uninstall/upgrade/start/stop）在两种形态下是同一套代码，
// 形态差异由 runtime 层吸收——这是把 agent 管理从 instance 收拢出来的核心。

const path = require('node:path');
const kinds = require('./kinds');
const model = require('./model');
const runtime = require('./runtime');

class AgentManager {
  constructor(opts) {
    this.root = opts.root;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.dist = opts.dist || null;
    this.tasks = opts.tasks || null;
    this.service = opts.service || null;
    this.tokens = opts.tokens || null;
    this.resstats = opts.resstats || null;
    this._agents = [];
  }

  // ---- 形态与查询 ----
  kinds() { return kinds.KINDS.slice(); }
  capabilitiesOf(kind) { return kinds.capabilitiesOf(kind); }

  list() { return this._agents.slice(); }
  find(id) { return this._agents.find((a) => a.id === id) || null; }

  inventory() {
    return this._agents.map((a) => ({
      id: a.id,
      product: a.product,
      kind: a.kind,
      port: a.port,
      capabilities: kinds.capabilitiesOf(a.kind),
      dataDir: model.dataDirOf(this.root, a),
      installDir: model.installDirOf(this.root, a),
    }));
  }

  // ---- 落点（UI 与清理逻辑都问这里，不各自拼路径）----
  entryOf(agent, opts) {
    return require('./ops/entry').entryOf(agent, Object.assign({ root: this.root }, opts || {}));
  }
  dataDirOf(agent) { return model.dataDirOf(this.root, agent); }
  installDirOf(agent) { return model.installDirOf(this.root, agent); }

  // ---- 生命周期五件套（待 ops 实现）----
  // 安装：prefix 由形态决定（model.installDirOf 已回答），本方法只负责选 prefix。
  // 没有 if(kind) 分支——沙箱用每实例 installDir，原生用 opts.npmRoot。
  async install(agent, opts) {
    const o = opts || {};
    const installOps = require('./ops/install');
    const prefix = o.prefix || (agent && agent.kind === 'sandbox'
      ? path.join(this.root, agent.id, 'install')
      : (o.npmRoot || null));
    if (!prefix) return { ok: false, error: '原生形态需显式提供 npmRoot（或 opts.prefix）' };
    return installOps.installToPrefix({
      product: o.product || { pkg: agent && agent.product },
      prefix,
      version: o.version || null,
      registry: o.registry || null,
      dist: o.dist || this.dist,
      launcher: o.launcher || null,
      commandTemplate: o.commandTemplate || null,
      log: o.log || null,
      onLine: o.onLine || null,
      timeoutMs: o.timeoutMs || null,
    });
  }
  // 卸载：safeAncestors 是安全边界，必填且由调用方给（壳知道产品数据根在哪）。
  // 缺它就不许删——这是本方法唯一不容妥协的规则。
  async uninstall(agent, opts) {
    const o = opts || {};
    const uninstallOps = require('./ops/uninstall');
    const isSandbox = agent && agent.kind === 'sandbox';
    const prefix = o.prefix || (isSandbox ? path.join(this.root, agent.id, 'install') : (o.npmRoot || null));
    // 安全边界：显式传入优先；否则按形态推（沙箱=root/<id>，原生=npmRoot）。
    // 显式传空数组 = 调用方明确表示「不给边界」，必须尊重为拒绝，
    // 不能回退到自动推断（那会把「我想禁止删除」变成「按默认边界删」）。
    const ancestors = Array.isArray(o.safeAncestors)
      ? o.safeAncestors.filter(Boolean)
      : [isSandbox ? path.join(this.root, agent.id) : (o.npmRoot || null)].filter(Boolean);
    return uninstallOps.uninstall(Object.assign({}, o.env || {}, {
      safeAncestors: ancestors,
      extraPaths: o.extraPaths || [],
      pkg: (o.product && o.product.pkg) || (agent && agent.product) || null,
      prefix,
      isActive: o.isActive || (o.env && o.env.isActive) || null,
      stop: o.stop || (o.env && o.env.stop) || null,
      runNpm: o.runNpm || (o.env && o.env.runNpm) || null,
      events: o.events || this.events,
      log: o.log || ((m) => this.logger && this.logger.warn && this.logger.warn(m)),
      state: o.state || (o.env && o.env.state) || {},
      tasks: o.tasks || this.tasks,
    }), o.cfg || {});
  }
  // 升级：env 由调用方（装配层）提供——壳持有进程句柄与 hooks，
  // 内核只提供业务判据。本方法只负责把 agent 形态相关的 prefix/包名填进去。
  async upgrade(agent, opts) {
    const o = opts || {};
    const upgradeOps = require('./ops/upgrade');
    const env = o.env || {};
    // 形态相关：沙箱用每实例 installDir，原生用 npmRoot
    const prefix = o.prefix || (agent && agent.kind === 'sandbox'
      ? path.join(this.root, agent.id, 'install')
      : (o.npmRoot || null));
    const pkg = (o.product && o.product.pkg) || (agent && agent.product);
    // 用 ops/install 的 installToPrefix 包一层，使 env.install 按 prefix 生效
    const installOps = require('./ops/install');
    const wrapped = Object.assign({}, env, {
      install: env.install || (async (v, registry) => installOps.installToPrefix({
        product: { pkg },
        prefix,
        version: v,
        registry: registry || null,
        dist: o.dist || this.dist,
        launcher: o.launcher || null,
        log: o.log || null,
        timeoutMs: o.timeoutMs || null,
      })),
      installedVersion: env.installedVersion || (() => (prefix && pkg ? installOps.installedVersionAt(prefix, pkg) : null)),
      // latestVersion 兜底：env 没给就用 install 的 resolver（带 TTL 缓存）。
      // 少了这个，调用方只提供 installedVersion 时会走到「无法获取最新版本」。
      latestVersion: env.latestVersion || (async () => {
        if (!pkg) return { ok: false, error: '未指定 agent 包名' };
        const resolver = o.latest || installOps.createLatestResolver(o.dist || this.dist, o);
        return resolver(pkg);
      }),
    });
    return upgradeOps.upgrade(wrapped, o.version || null, o.cfg || {});
  }
  start(agent) {
    throw new Error('agent.start: 待 ops/lifecycle 实现');
  }
  stop(agent) {
    throw new Error('agent.stop: 待 ops/lifecycle 实现');
  }
  // 状态投影：组合 versionInfo（版本面）+ 调用方给的 phase（进程面）。
  // 原实现的 status() 混装两者，此处分开传、在此处合，便于两种形态各自提供。
  status(agent, state) {
    const st = require('./status');
    const s = state || {};
    return Object.assign({}, st.versionInfo(s, s.installedFallback || null), {
      phase: s.phase || null,
      busy: st.busy(s),
    });
  }

  // ---- 更新检查 ----
  async checkUpdate(agent, opts) {
    const o = opts || {};
    const installOps = require('./ops/install');
    const status = require('./status');
    const pkg = (o.product && o.product.pkg) || (agent && agent.product);
    if (!pkg) return { ok: false, error: '未指定 agent 包名' };
    const latest = o.latest || installOps.createLatestResolver(o.dist || this.dist, o);
    const r = await latest(pkg);
    if (!r || r.ok !== true) return { ok: false, error: (r && r.error) || '查询失败', installed: o.installed || null, latest: null, updateAvailable: false };
    const installed = o.installed || installOps.installedVersionAt(
      agent && agent.kind === 'sandbox' ? path.join(this.root, agent.id, 'install') : (o.npmRoot || null), pkg);
    return {
      ok: true,
      installed: installed || null,
      latest: r.version,
      updateAvailable: !!(installed && status.isNewer(r.version, installed)),
      origin: r.origin || null,
    };
  }
  // 升级状态投影：字段名与 status.upgradeBrief 一致（UI 免改）。
  upgradeStatus(agent, state) {
    const status = require('./status');
    return status.upgradeBrief(state || {});
  }

  // ---- 内部：登记（供 ops 与迁移期调用）----
  _register(raw) {
    const a = model.normalizeAgent(raw);
    if (a) this._agents.push(a);
    return a;
  }
}

module.exports = { AgentManager, kinds, model, runtime };