'use strict';

const hub = require('../../platform/service/log/hub');
const SHARED = require('../../shared/shared-constants');


function ctlCall(port, method, args, timeoutMs) {
  return hub.ctlCall(port, method, args, timeoutMs || 120000, { withErrorFields: true });
}

function routerCtlPort(config) { return Number(config && config.routerCtlPort) || SHARED.net.routerCtlPort; }

function lanCtlPort(config) { return Number(config && config.lanCtlPort) || SHARED.net.lanCtlPort; }

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

// routerCtlPort / lanCtlPort 是 ctl 端口缺省值的唯一权威实现，必须导出：
// app/assembly/compose/core.js 曾就地内联重写一份（且漏了 shared-constants 的
// require，任何非数字配置值都会在组装期抛 ReferenceError 打崩 Supervisor 启动）。
// 收敛为一份后，compose 通过 require 直接复用，不再各自解析。
module.exports = { createCtlClient, methods, routerCtlPort, lanCtlPort };
