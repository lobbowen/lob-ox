'use strict';

// relay 域契约声明（纯数据，零 require）。
// exports 取自 index.js 的 module.exports 字面量键（DG-9）；PUBLIC_API 为全仓消费点与对外契约面（DG-10）；
// deps.hooks 是 DG-4b 豁免出处（mainOf/tokenOf）；pure 为零 IO require 的纯文件（DG-3）：仅 core.js。

module.exports = {
  domain: 'relay',

  exports: ['createRelay', 'LanManager', 'FrpManager', 'frpPlatformTag', 'downloadUrls'],

  PUBLIC_API: [
    // 门面导出（createRelay 服务构造）
    'createRelay', 'frpPlatformTag', 'downloadUrls',
    // LanManager（反代/frp 编排 + 对账；remoteMode 写入属 app 动作层，域内只收敛执行）
    'localAddresses', 'list', 'frpStatus', 'frpAction', 'syncFrpc',
    'reconcile', 'targetReachable', 'removeProxyForInstance', 'syncProxy',
    'instanceStart', 'instanceStop', 'shutdown', 'applyToken',
    // FrpManager
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
