'use strict';

// ctl 协作方工厂：组合 ctl 客户端与 ctl 门面工厂。
// 公开键与 assembly/collaborators.js 的 THIN_SPEC.ctl 逐字一致：call / lanCall / lanPort / routerPort / routerFacade。
// deps 一律惰性 getter（装配期 host 未就绪）。

const { createCtlClient } = require('./client');
const { createRouterCtlFacade } = require('./facades');

/** @param deps { getConfig, getCtlCall?, getLanCtlCall?, getLanCtlPort?, getRouterCtlPort?, getRouterFacade? }
 *  必填 getConfig（惰性取宿主 config）。可选宿主 getter：提供时公开键实时取 host 上既有同名实现，
 *  使 host.ctl.* 与 host._* 走同一调用路径（含测试对 host._lanCtlCall 的覆写面）；缺省用本工厂实现。 */
function createCtl(deps) {
  const g = deps || {};
  const client = createCtlClient({ getConfig: g.getConfig });

  // 工厂自持的真实实现（不依赖宿主即可用）。
  const impl = {
    call: client.ctlCall,
    lanCall: client.lanCtlCall,
    lanPort: client.lanCtlPort,
    routerPort: client.routerCtlPort,
    routerFacade: () => createRouterCtlFacade({ getRouterPort: client.routerCtlPort, ctlCall: client.ctlCall }),
  };

  const src = {
    call: g.getCtlCall, lanCall: g.getLanCtlCall, lanPort: g.getLanCtlPort,
    routerPort: g.getRouterCtlPort, routerFacade: g.getRouterFacade,
  };
  const out = {};
  for (const key of Object.keys(impl)) {
    const get = src[key];
    out[key] = typeof get === 'function'
      ? (...args) => { const fn = get(); return typeof fn === 'function' ? fn(...args) : impl[key](...args); }
      : impl[key];
  }
  return out;
}

module.exports = { createCtl };
