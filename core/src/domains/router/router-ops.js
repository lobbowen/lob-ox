'use strict';

require('./port-segments');
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
