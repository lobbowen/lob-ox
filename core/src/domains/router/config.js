'use strict';

const { normalize } = require('../../platform/service/config');
const SHARED = require('../../shared/shared-constants');

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_CTL_PORT = SHARED.net.routerCtlPort;
const ROUTER_CTL_METHODS = Object.freeze([
  'status', 'domainSummary', 'portsView', 'listProviders', 'proxyApps', 'proxyUpdateStatus',
  'addDirectProvider', 'addProxyProvider', 'removeProvider',
  'activateProvider', 'deactivateProvider',
  'addProxyKey', 'setProviderKeys', 'removeProxyKey', 'setSelectedProxyKey', 'switchToKey',
  'discardAccount',
  'refreshProviderQuota', 'refreshProxyUpdateInfo', 'applyProxyUpdate',
  'commandcodeLoginStart', 'commandcodeLoginWait',
  'eventsTail',
]);

const CONFIG_PATH = process.env.DSH_SUPERVISOR_CONFIG || path.join(require('../../platform/service/state-root').supervisorDir(), 'config.json');

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return normalize(raw);
}

module.exports = { DEFAULT_CTL_PORT, ROUTER_CTL_METHODS, CONFIG_PATH, loadConfig };
