'use strict';

const { installCollaborators } = require('./collaborators');

const FACETS = [
  { name: 'assembly/bootstrap', mod: require('./bootstrap'), hostFirst: true },
  { name: 'assembly/api-rebind', mod: require('./api-rebind'), apiRebind: true },
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
  { name: 'domain-actions/router', mod: require('../domain-actions/router'), factory: 'createRouterActions' },
  { name: 'domain-actions/lan', mod: require('../domain-actions/lan'), factory: 'createLanActions' },
  { name: 'domain-actions/main', mod: require('../domain-actions/main'), factory: 'createMainActions' },
  { name: 'settings/env', mod: require('../settings/env') },
  { name: 'settings/node-lts', mod: require('../settings/node-lts') },
  { name: 'settings/versions', mod: require('../settings/versions') },
  { name: 'settings/access', mod: require('../settings/access') },
  { name: 'settings/browser', mod: require('../settings/browser') },
  { name: 'settings/lan-panel', mod: require('../settings/lan-panel') },
];

function installMethods(host, methods) {
  for (const name of Object.keys(methods || {})) {
    const fn = methods[name];
    if (typeof fn === 'function') host[name] = fn;
  }
}

function installAccessors(host, accessors) {
  for (const name of Object.keys(accessors || {})) {
    Object.defineProperty(host, name, accessors[name]);
  }
}

function installHostFirst(host, mod) {
  for (const name of Object.keys(mod)) {
    const fn = mod[name];
    if (typeof fn !== 'function') continue;
    host[name] = function (...args) { return fn(this, ...args); };
  }
}

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

function installFacets(host, deps) {
  const d = deps || {};
  for (const f of FACETS) {
    if (f.apiRebind) {
      host._apiStart = function _apiStart() { return f.mod.startApi(this, d.createServer); };      host._apiRebind = function _apiRebind() { return f.mod._rebindApiHost(this, d.createServer); };
      continue;
    }
    if (f.hostFirst) { installHostFirst(host, f.mod); continue; }
    if (f.factory) { installMethods(host, f.mod[f.factory](domainActionDeps(host))); continue; }
    if (f.mod.methods) installMethods(host, f.mod.methods);
    if (f.mod.accessors) installAccessors(host, f.mod.accessors);
  }
  installCollaborators(host, { validate: true });
}

module.exports = { FACETS, installFacets };
