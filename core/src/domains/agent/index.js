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
  install(agent, version) {
    throw new Error('agent.install: 待 ops/install 实现');
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
  checkUpdate(agent) {
    throw new Error('agent.checkUpdate: 待 ops/upgrade 实现');
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