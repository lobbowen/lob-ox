'use strict';

const { createCtlClient } = require('./client');
const { createRouterCtlFacade } = require('./facades');

function createCtl(deps) {
  const g = deps || {};
  const client = createCtlClient({ getConfig: g.getConfig });

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
