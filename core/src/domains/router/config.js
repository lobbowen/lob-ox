'use strict';

const { normalize } = require('../../platform/service/config');

// router 域配置与常量（半纯：路径派生 + 常量，无进程副作用；loadConfig 只在被调用时读盘）。

const path = require('node:path');
const fs = require('node:fs');

// router 域的 ctl 控制面（域知识，装配期由 daemon 显式注入 platform/ctl/server.js）。
// 收录原则：守卫视图/写操作真正需要的公开方法；内部方法（_ 前缀）一律不收录。
// eventsTail 是 dispatcher 的内置特例（守卫 EventHub 增量拉事件），须显式登记才可达。
const DEFAULT_CTL_PORT = 43107;
const ROUTER_CTL_METHODS = Object.freeze([
  'status', 'domainSummary', 'portsView', 'listProviders', 'proxyApps', 'proxyUpdateStatus',
  'addDirectProvider', 'addProxyProvider', 'removeProvider',
  'activateProvider', 'deactivateProvider',
  'addProxyKey', 'setProviderKeys', 'removeProxyKey', 'setSelectedProxyKey', 'switchToKey',
  'discardAccount',
  'refreshProviderQuota', 'refreshProxyUpdateInfo', 'applyProxyUpdate',
  'commandcodeLoginStart', 'commandcodeLoginWait',
  'eventsTail',
]);

const CONFIG_PATH = process.env.DSH_SUPERVISOR_CONFIG || path.join(require('../../platform/service/state-root').supervisorDir(), 'config.json');

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // normalize 展开 ~ 路径等（与守卫同源，保证 providerFile/ports.json 等路径一致）。
  // platform 的 DEFAULTS 不含业务域键（routerCtlPort 等）：端口以本域常量 DEFAULT_CTL_PORT
  // 兜底——domains 到 app 属非法依赖边。
  return normalize(raw);
}

module.exports = { DEFAULT_CTL_PORT, ROUTER_CTL_METHODS, CONFIG_PATH, loadConfig };
