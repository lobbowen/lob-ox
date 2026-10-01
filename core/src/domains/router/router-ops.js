'use strict';

// 运维门面（组合 + 导出），不承载业务逻辑：组合 ops/{oauth,apps-registry,quotasync,admin}，
// createAuxCore(deps) 显式注入依赖。

require('./port-segments'); // 本域端口段/独立池申报（require 即注入）
const ports = require('../../platform/service/ports').shared;
const platform = require('../../platform/os/index');
const { maskKey } = require('./providers/base');
const { createOAuthOps } = require('./ops/oauth');
const { createAppsRegistryOps } = require('./ops/apps-registry');
const { createQuotaSyncOps } = require('./ops/quotasync');
const { createAdminOps } = require('./ops/admin');

function createAuxCore(deps) {
  const d = deps || {};
  const getProviders = d.getProviders || (() => []);
  // 一键登录只传「意图」不传机制：profile 落盘、引擎方言、反指纹环境、档位与图形会话预检全在
  //   平台层的唯一出口实现；logger 一并交下去，本域不自己落日志。
  const openInBrowser = (url, onExit) => platform.browser.openBrowser(url, { intent: 'isolated-login', onExit, logger: d.logger });
  const oauth = createOAuthOps({ ports, openInBrowser });
  const apps = createAppsRegistryOps({
    getProviders, proxyUpdateCache: d.proxyUpdateCache, dist: d.dist,
    events: d.events, tasks: d.tasks, save: d.save, logger: d.logger,
  });
  const quota = createQuotaSyncOps({
    getProviders, findProvider: d.findProvider, save: d.save,
    events: d.events, setPriceIndex: d.setPriceIndex,
  });
  const admin = createAdminOps({
    findProvider: d.findProvider, save: d.save, ports, maskKey, logger: d.logger,
  });
  return { ...oauth, ...apps, ...quota, ...admin };
}

module.exports = { createAuxCore };
