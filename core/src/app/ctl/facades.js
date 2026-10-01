'use strict';

const { createCtlClient } = require('./client');

const BANNED = new Set(['then', 'constructor', 'toJSON', 'inspect', 'Symbol.toPrimitive', '__proto__', 'prototype', 'defineProperty', 'defineGetter', 'defineSetter', 'apply', 'call', 'bind']);

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

function createRouterCtlFacade(deps) {
  const g = deps || {};
  const port = g.getRouterPort();
  return createCtlFacade({ port, ctlCall: g.ctlCall });
}

const methods = {
  _makeRouterFacade() {
    const client = createCtlClient({ getConfig: () => this.config });
    return createRouterCtlFacade({ getRouterPort: client.routerCtlPort, ctlCall: client.ctlCall });
  },
};

module.exports = { createCtlFacade, createRouterCtlFacade, methods };
