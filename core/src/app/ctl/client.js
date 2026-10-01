'use strict';

const hub = require('../../platform/service/log/hub');

function ctlCall(port, method, args, timeoutMs) {
  return hub.ctlCall(port, method, args, timeoutMs || 120000, { withErrorFields: true });
}

function routerCtlPort(config) { return Number(config && config.routerCtlPort) || 43107; }

function lanCtlPort(config) { return Number(config && config.lanCtlPort) || 43108; }

function createCtlClient(deps) {
  const g = deps || {};
  const config = () => (typeof g.getConfig === 'function' ? g.getConfig() : null);
  return {
    ctlCall,
    routerCtlPort: () => routerCtlPort(config()),
    lanCtlPort: () => lanCtlPort(config()),
    lanCtlCall: (method, args, timeoutMs) => ctlCall(lanCtlPort(config()), method, args, timeoutMs),
  };
}

const methods = {
  _ctlCall: ctlCall,
  _routerCtlPort() { return routerCtlPort(this.config); },
  _lanCtlPort() { return lanCtlPort(this.config); },
  _lanCtlCall(method, args, timeoutMs) { return ctlCall(lanCtlPort(this.config), method, args, timeoutMs); },
};

module.exports = { createCtlClient, methods };
