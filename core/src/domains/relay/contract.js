'use strict';

module.exports = {
  domain: 'relay',

  exports: ['createRelay', 'LanManager', 'FrpManager', 'frpPlatformTag', 'downloadUrls'],

  PUBLIC_API: [
    'createRelay', 'frpPlatformTag', 'downloadUrls',
    'localAddresses', 'list', 'frpStatus', 'frpAction', 'syncFrpc',
    'reconcile', 'targetReachable', 'removeProxyForInstance', 'syncProxy',
    'instanceStart', 'instanceStop', 'shutdown', 'applyToken',
    'loadSettings', 'saveSettings', 'status', 'buildConfig',
    'syncFromInstances', 'restart', 'start', 'stop', 'install',
  ],

  classApi: {
    LanManager: [
      'localAddresses', 'list', 'frpStatus', 'frpAction', 'syncFrpc',
      'reconcile', 'targetReachable', 'removeProxyForInstance', 'syncProxy',
      'instanceStart', 'instanceStop', 'shutdown', 'applyToken',
    ],
    FrpManager: ['loadSettings', 'saveSettings', 'status', 'buildConfig', 'syncFromInstances', 'restart', 'start', 'stop', 'install'],
  },

  deps: {
    logger: '日志器',
    events: '事件账本',
    configPath: 'relay 配置路径',
    stateDir: 'relay 状态目录',
    instances: 'InstanceSource（后续端口化；现为整个 InstanceManager）',
    hooks: {
      mainOf: '取主实例视图',
      tokenOf: '按 id 取访问令牌',
    },
  },

  hooks: { mainOf: true, tokenOf: true },

  pure: ['domains/relay/core.js'],

  exempt: {
    hooks: 'mainOf/tokenOf 为注入依赖（非域内跨文件 this）',
    'core.js': 'node:crypto 为纯计算，不计 IO',
  },
};
