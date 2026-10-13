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
  uninstall(agent) {
    throw new Error('agent.uninstall: 待 ops/uninstall 实现');
  }
  upgrade(agent, version) {
    throw new Error('agent.upgrade: 待 ops/upgrade 实现');
  }
  start(agent) {
    throw new Error('agent.start: 待 ops/lifecycle 实现');
  }
  stop(agent) {
    throw new Error('agent.stop: 待 ops/lifecycle 实现');
  }
  status(agent) {
    throw new Error('agent.status: 待 ops/status 实现');
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
  upgradeStatus(agent) {
    throw new Error('agent.upgradeStatus: 待 ops/upgrade 实现');
  }

  // ---- 内部：登记（供 ops 与迁移期调用）----
  _register(raw) {
    const a = model.normalizeAgent(raw);
    if (a) this._agents.push(a);
    return a;
  }
}

module.exports = { AgentManager, kinds, model, runtime };