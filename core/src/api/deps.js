'use strict';

const GATEWAY = {
  sup: ['config', 'tokenService'],
};

const DOMAIN_DEPS = {
  tasks: ['tasks'],

  lifecycle: [
    'config',
    'desired', 'phase',
    'eventHub',
    'events',
    'health',
    'lifecycleManager',
    'sessionState',
    'shutdownAll',
    'statusSummary',
  ],

  native: [
    'config',
    'nativeManager',
    'patchDshMain',
  ],

  guard: [
    'config',
    'nativeManager',
    'guardVersionLocal', 'guardVersionCheck',
    'autostartStatus', 'setAutostart',
    'lanPanelStatus', 'setLanPanel',
    'accessKeyStatus', 'setAccessKey',
    'closeActionStatus', 'setCloseAction',
    'externalBrowserStatus', 'setExternalBrowser',
    'shutdownAll',
    'guardSelfUpdateStatus',
    'dshenvStatus', 'envStatus', 'nodeLtsStatus',
    'listPorts',
  ],

  router: [
    'config',
    'routerApi',
    'routerDomainSummary',
    'routerProviders', 'routerStatusView',
    'setRouterRunning',
  ],

  plugins: ['config', 'pluginManager', 'pluginMarket'],

  dist: ['config', 'dist'],

  instances: [
    'config',
    'instances',
    'dshMainView',
  ],

  relay: ['config', 'frpStatus', 'listLan', 'setRemoteMode', 'setRemoteToken', 'lanFrpc'],

  shell: [
    'config',
    'shellDomain',
    'dist',
    'events',
  ],
};

module.exports = { GATEWAY, DOMAIN_DEPS };
