'use strict';

// app/assembly/facets.js —— 编排层切面装配清单 + 兼容门面落地。FACETS 是「哪些模块 -> 哪些成员」的唯一声明处，
// 装配目标是 host 实例（Supervisor 的组装上下文），不触碰任何 prototype（DG-8 / DS-G3b）。
// 四种形态：{ methods } 成员方法（this = host，跨文件 this.X() 语义不变）/ { accessors } get-set 描述符 / host-first 自由函数（包装成 fn(this, ...args)）/ api-rebind（createServer 由 root 注入，DS-3）。

const { installCollaborators } = require('./collaborators');

// 切面清单：数组顺序即覆盖序，同名成员后装者胜，调整顺序会改变落地结果。
const FACETS = [
  { name: 'assembly/bootstrap', mod: require('./bootstrap'), hostFirst: true },
  { name: 'assembly/api-rebind', mod: require('./api-rebind'), apiRebind: true },
  // session/state/control 不在本清单：它们是真 ctor 工厂，由 assembly/collaborators.js 装配。
  { name: 'session/shutdown', mod: require('../session/shutdown'), hostFirst: true },
  { name: 'self/notify', mod: require('../self/notify'), hostFirst: true },
  { name: 'control/scheduler', mod: require('../control/scheduler') },
  { name: 'control/instance-adapter', mod: require('../control/instance-adapter') },
  { name: 'main/decide', mod: require('../main/decide') },
  { name: 'main/controller', mod: require('../main/controller') },
  { name: 'main/shadow', mod: require('../main/shadow') },
  { name: 'main/process', mod: require('../main/process') },
  { name: 'main/port-rederive', mod: require('../main/port-rederive') },
  { name: 'main/signals', mod: require('../main/signals') },
  { name: 'main/health-gate', mod: require('../main/health-gate') },
  { name: 'daemons/supervise', mod: require('../daemons/supervise') },
  { name: 'daemons/runtime', mod: require('../daemons/runtime') },
  { name: 'daemons/identity', mod: require('../daemons/identity') },
  { name: 'daemons/probe', mod: require('../daemons/probe') },
  { name: 'ctl/client', mod: require('../ctl/client') },
  { name: 'ctl/facades', mod: require('../ctl/facades') },
  { name: 'facade/router', mod: require('../facade/router') },
  { name: 'facade/lan', mod: require('../facade/lan') },
  { name: 'facade/ports', mod: require('../facade/ports') },
  { name: 'facade/main', mod: require('../facade/main') },
  { name: 'facade/status', mod: require('../facade/status'), hostFirst: true },
  // 域写动作在 app/domain-actions/（facade 侧只读）：三者是真 ctor 工厂，实现体经显式 deps
  //   取事实、不直连 this；按 factory 名在装配期构造后把产物平铺安装到 host，
  //   平铺名必须与 api 消费面（setRouterRunning / patchDshMain / setRemoteMode 等）逐个一致。
  { name: 'domain-actions/router', mod: require('../domain-actions/router'), factory: 'createRouterActions' },
  { name: 'domain-actions/lan', mod: require('../domain-actions/lan'), factory: 'createLanActions' },
  { name: 'domain-actions/main', mod: require('../domain-actions/main'), factory: 'createMainActions' },
  // audit/orphan-scan 不在本清单：它是真 ctor 工厂（assembly/collaborators.js 的 installAuditFactory
  //   构造 host.audit），实现体本身只是纯函数，不再需要 host 兼容外壳切面。
  { name: 'settings/env', mod: require('../settings/env') },
  { name: 'settings/node-lts', mod: require('../settings/node-lts') },
  { name: 'settings/versions', mod: require('../settings/versions') },
  { name: 'settings/access', mod: require('../settings/access') },
  { name: 'settings/browser', mod: require('../settings/browser') },
  { name: 'settings/lan-panel', mod: require('../settings/lan-panel') },
];

/** 把 methods 逐个装到 host 实例（不碰 prototype）。 */
function installMethods(host, methods) {
  for (const name of Object.keys(methods || {})) {
    const fn = methods[name];
    if (typeof fn === 'function') host[name] = fn;
  }
}

/** 把 accessors 逐个装到 host 实例（get/set 无法经赋值复制）。 */
function installAccessors(host, accessors) {
  for (const name of Object.keys(accessors || {})) {
    Object.defineProperty(host, name, accessors[name]);
  }
}

/** host-first 自由函数模块：把 (host, ...args) 绑成 host 上的方法（this 动态）。 */
function installHostFirst(host, mod) {
  for (const name of Object.keys(mod)) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    host[name] = function (...args) { return fn(this, ...args); };
  }
}

/** 域写动作工厂的惰性 deps：装配期 host 尚未就绪，故一律 getter（与 collaborators.js 同范式）。
 *  deps 是三个工厂（router/lan/main）实际取用成员的并集，多出的键不会被读到。 */
function domainActionDeps(host) {
  return {
    getConfig: () => host.config,
    getDaemons: () => host.daemons,
    getState: () => host.state,
    getViews: () => host.views,
    getInstances: () => host.instances,
    getRouter: () => host.router,
    getLan: () => host.lan,
    getCtl: () => host.ctl,
    getEvents: () => host.events,
    getLogger: () => host.logger,
    getLifecycleManager: () => host.lifecycleManager,
  };
}

/** 组装期把全部切面装到 host 实例：必须在 composeSystem 业务体之前调用
 *  （compose 各步构造期即经 host._mSetX()/_bindNativeDshCommand()/loadState() 取用）。
 *  deps.createServer 由 root 注入（app 不得 require api，DS-3）。 */
function installFacets(host, deps) {
  const d = deps || {};
  for (const f of FACETS) {
    if (f.apiRebind) {
      host._apiStart = function _apiStart() { return f.mod.startApi(this, d.createServer); };      host._apiRebind = function _apiRebind() { return f.mod._rebindApiHost(this, d.createServer); };
      continue;
    }
    if (f.hostFirst) { installHostFirst(host, f.mod); continue; }
    // 域写动作工厂：构造后把产物平铺安装，平铺名就是 api 消费面的名字，不得改名。
    if (f.factory) { installMethods(host, f.mod[f.factory](domainActionDeps(host))); continue; }
    if (f.mod.methods) installMethods(host, f.mod.methods);
    if (f.mod.accessors) installAccessors(host, f.mod.accessors);
  }
  // state/session/control 由真 ctor 工厂构造（自己持有实现）；其余切面为薄委托。
  // 必须在全部切面装毕之后：薄委托协作方转发到 host 上的既有切面方法。
  installCollaborators(host, { validate: true });
}

module.exports = { FACETS, installFacets };
