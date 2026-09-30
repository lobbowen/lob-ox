'use strict';

// ctl 门面工厂：把 ctl 端口包成方法转发 Proxy，具名工厂 + deps 注入（现仅 router 侧消费）。
// routerApi() 门面在 app/facade/router.js：本文件只保留通用 Proxy 构造、供其单向取用，
// 避免 facade/router 与 ctl/facades 互相调用成环。

const { createCtlClient } = require('./client');

// 反射禁区：这些属性名若被当作 ctl 方法转发，会落到 Proxy/对象内部语义
// （thenable 陷阱、原型污染、Function 元操作），必须显式拒绝。
const BANNED = new Set(['then', 'constructor', 'toJSON', 'inspect', 'Symbol.toPrimitive', '__proto__', 'prototype', 'defineProperty', 'defineGetter', 'defineSetter', 'apply', 'call', 'bind']);

/** 把一个 ctl 端口包成「属性名即方法名」的转发 Proxy。deps: { port, ctlCall }。 */
function createCtlFacade(deps) {
  const g = deps || {};
  const port = g.port;
  const call = g.ctlCall;
  const cache = new Map();
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (BANNED.has(prop)) return undefined;
      if (cache.has(prop)) return cache.get(prop);
      const fn = (...args) => call(port, prop, args);
      cache.set(prop, fn);
      return fn;
    },
    has() { return true; },
  });
}

/** router ctl 门面：端口在构造时解析一次。deps: { getRouterPort, ctlCall }。 */
function createRouterCtlFacade(deps) {
  const g = deps || {};
  const port = g.getRouterPort();
  return createCtlFacade({ port, ctlCall: g.ctlCall });
}

// host 既有方法安装（facets.js 的 { methods } 形状不动）：config 为宿主字段读取，
// ctl 调用经 createCtlClient 显式构造。
const methods = {
  _makeRouterFacade() {
    const client = createCtlClient({ getConfig: () => this.config });
    return createRouterCtlFacade({ getRouterPort: client.routerCtlPort, ctlCall: client.ctlCall });
  },
};

module.exports = { createCtlFacade, createRouterCtlFacade, methods };
