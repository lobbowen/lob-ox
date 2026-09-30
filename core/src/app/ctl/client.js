'use strict';

const hub = require('../../platform/service/log/hub');

// ctl 客户端工厂：router(43107)/lan(43108) 控制通道调用与端口解析。
// 具名纯函数 + deps 注入；host 兼容方法见文件末 methods。

/** 通用 ctl 调用（router 43107 / lan 43108 共用），实现为 hub.ctlCall。
 *  本包装只负责本层契约：默认 120s（面板写操作可达秒级）+ 在 Error 上挂 ok/error。 */
function ctlCall(port, method, args, timeoutMs) {
  return hub.ctlCall(port, method, args, timeoutMs || 120000, { withErrorFields: true });
}

/** router-daemon 控制通道端口（单一来源：config；缺省见 platform/service/config DEFAULTS）。
 *  必须与 providerApi 动态分配段解耦（如 43011 落在其内会端口双占）。 */
function routerCtlPort(config) { return Number(config && config.routerCtlPort) || 43107; }

/** lan-daemon 控制通道端口（单一来源：config）。 */
function lanCtlPort(config) { return Number(config && config.lanCtlPort) || 43108; }

/**
 * ctl 客户端工厂。deps 为惰性 getter：{ getConfig }。
 * 返回 { ctlCall, routerCtlPort, lanCtlPort, lanCtlCall }。
 */
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

// host 既有方法安装（facets.js 的 { methods } 形状不动）：其他切面仍经宿主方法取用；
// config 为宿主字段读取，其余走上面的具名函数。
const methods = {
  _ctlCall: ctlCall,
  _routerCtlPort() { return routerCtlPort(this.config); },
  _lanCtlPort() { return lanCtlPort(this.config); },
  _lanCtlCall(method, args, timeoutMs) { return ctlCall(lanCtlPort(this.config), method, args, timeoutMs); },
};

module.exports = { createCtlClient, methods };
