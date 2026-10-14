'use strict';

// 壳的版本检查。唯一实现路径是委托 agent 域的 AgentManager.checkUpdate ——
// 那里已用 status.isNewer（shared/version.js 的 semverCompare）作唯一判据。
// 此前本文件根本不存在，而 api/domains/shell.js:32 直接调用 shell.checkUpdate，
// domains/shell/index.js 也没有导出它 —— 于是这个在 api/contract.js:89 声明为
// public、被 UI AboutCard 消费的路由每次调用都抛 TypeError。
// 在本层重新实现一份 semver 比较或再调一次 registry，都会让「已装 vs 最新」
// 出现第二个判据，因此这里只做身份组装与委派。

const path = require('node:path');
const SHARED = require('../../shared/shared-constants');
const { AgentManager } = require('../agent/index');

// 壳以 native 形态安装，包名取自 shared-constants 的 product.shellReleasePkg。
const SHELL_AGENT = {
  id: 'shell',
  kind: 'native',
  product: { pkg: SHARED.product.shellReleasePkg },
};

// compose/domains.js:47 已在 host 上装配了一个 AgentManager（供 instance/nativeAgent
// 共享）。checkUpdate 只读它的 checkUpdate/latest 查询能力，不写盘、不持有状态，
// 但为避免同一进程里存在第二个 manager（各自 _agents 列表、各自 root 推导），
// 装配时优先复用 host.agents；仅在没有装配的场景（如单元直调）才自建。
function resolveManager(opts) {
  const o = opts || {};
  if (o.agents && typeof o.agents.checkUpdate === 'function') return o.agents;
  if (!resolveManager._fallback) {
    resolveManager._fallback = new AgentManager({
      root: o.stateDir ? path.join(o.stateDir, 'agents') : null,
      dist: o.dist || null,
    });
  }
  return resolveManager._fallback;
}

/**
 * @param {object} dist 统一分发器（npm 版本查询）
 * @param {{authoritative?: boolean, installed?: string|null, agents?: object, stateDir?: string}} [opts]
 */
async function checkUpdate(dist, opts) {
  const o = opts || {};
  const mgr = resolveManager({ agents: o.agents, stateDir: o.stateDir, dist });
  return mgr.checkUpdate(SHELL_AGENT, {
    dist,
    product: SHELL_AGENT.product,
    installed: o.installed === undefined ? null : o.installed,
    authoritative: !!o.authoritative,
  });
}

module.exports = { checkUpdate, SHELL_AGENT };
