'use strict';

module.exports = {
  domain: 'router',

  exports: ['RouterService'],

  PUBLIC_API: [
    'start', 'stop', 'stopAndWait', 'stopAllInstances',
    'status', 'domainSummary', 'portsView', 'listProviders',
    'addDirectProvider', 'addProxyProvider', 'removeProvider', 'getProvider',
    'handleForProvider', 'activateProvider', 'deactivateProvider',
    'canPersist', 'setPersistEnabled', 'readBody', 'log',
    'proxyFor', 'getUsage', 'recordUsage', 'recordError',
    'commandcodeLoginStart', 'commandcodeLoginWait', 'proxyApps',
    'refreshProxyUpdateInfo', 'applyProxyUpdate', 'proxyUpdateStatus',
    'refreshOfficialUsageAll', 'refreshProviderQuota', 'refreshOfficialPricingAll',
    'setProviderKeys', 'setSelectedProxyKey', 'switchToKey',
    'removeProxyKey', 'addProxyKey', 'discardAccount',
    'presets', 'providers',
  ],

  classApi: {
    RouterService: [
      'start', 'stop', 'stopAndWait', 'stopAllInstances',
      'status', 'domainSummary', 'portsView', 'listProviders',
      'addDirectProvider', 'addProxyProvider', 'removeProvider', 'getProvider',
      'handleForProvider', 'activateProvider', 'deactivateProvider',
      'canPersist', 'setPersistEnabled', 'readBody', 'log',
      'proxyFor', 'getUsage', 'recordUsage', 'recordError',
      'commandcodeLoginStart', 'commandcodeLoginWait', 'proxyApps',
      'refreshProxyUpdateInfo', 'applyProxyUpdate', 'proxyUpdateStatus',
      'refreshOfficialUsageAll', 'refreshProviderQuota', 'refreshOfficialPricingAll',
      'setProviderKeys', 'setSelectedProxyKey', 'switchToKey',
      'removeProxyKey', 'addProxyKey', 'discardAccount',
    ],
  },

  deps: {
    config: '运行配置',
    dist: '统一分发（npm 查询）',
    logger: '日志器',
    events: '事件账本',
    tasks: '统一任务注册表',
    providerFile: 'providers.json 路径',
    usageTotalsFile: 'usage-totals.json 路径',
    portsFile: '端口注册表隔离文件（可选）',
    hooks: {
      onPersist: 'selected 失效自动清理时的持久化回调（switch/store 注入）',
      _ccLoginReject: 'CommandCode OAuth 登录取消（ops/oauth.js 的 promise 决议器，非域内 this 调用）',
      _ccLoginResolve: 'CommandCode OAuth 登录完成（ops/oauth.js 的 promise 决议器，非域内 this 调用）',
    },
  },

  hooks: { onPersist: true, _ccLoginReject: true, _ccLoginResolve: true },

  pure: [
    'domains/router/handlers/parse.js',
    'domains/router/model.js',
    'domains/router/model/inflight.js',
    'domains/router/policies/failure.js',
    'domains/router/policies/switch.js',
    'domains/router/providers/command.js',
    'domains/router/providers/model.js',
    'domains/router/providers/policies/quota.js',
    'domains/router/providers/policies/freeze.js',
    'domains/router/providers/pool.js',
    'domains/router/proxy-apps.js',
    'domains/router/views.js',
  ],

  exempt: {
    'providers/base.js': '1 个抽象契约占位（detectAccount，must be implemented by subclass）',
  },
};
