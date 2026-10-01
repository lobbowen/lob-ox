'use strict';

module.exports = {
  domain: 'plugin',

  exports: ['PluginManager', 'PluginMarket', 'PROTECTED'],

  PUBLIC_API: [
    'resolveTargets', 'installedOn', 'inventory', 'readManifest', 'overlayEntries',
    'listInstalled', 'setBundleEnabled', 'saveOverlayEntries',
    'install', 'uninstall', 'installStatus', 'checkUpdates', 'update',
    'getIndex', 'loadFromDisk', 'saveToDisk', 'buildIndex',
    'indexNpm', 'indexGithub', 'indexCommunity', 'safeFetchLatest', 'safeRepoPkg',
  ],

  classApi: {
    PluginManager: [
      'resolveTargets', 'installedOn', 'inventory', 'readManifest', 'overlayEntries',
      'listInstalled', 'setBundleEnabled', 'saveOverlayEntries',
      'install', 'uninstall', 'installStatus', 'checkUpdates', 'update',
    ],
    PluginMarket: [
      'getIndex', 'loadFromDisk', 'saveToDisk', 'buildIndex',
      'indexNpm', 'indexGithub', 'indexCommunity', 'safeFetchLatest', 'safeRepoPkg',
    ],
  },

  deps: {
    dshBin: 'DSH 可执行名',
    profileName: '原生 profile 名',
    profileDir: '原生 profile 目录',
    overlayFile: '补丁层文件',
    dshPort: '原生 DSH 端口',
    instances: 'InstanceManager 目标数据源（后续端口化为 InstanceTargetPort）',
    logger: '日志器',
    events: '事件账本',
    dist: '统一分发（registry 查询）',
    tasks: '统一安装/更新任务注册表',
    hooks: {
      onNativeRestart: '原生 DSH 重启回调（supervisor 注入，restart.js 消费）',
    },
  },

  hooks: { onNativeRestart: true },

  pure: [
    'domains/plugin/model.js',
    'domains/plugin/policies.js',
    'domains/plugin/policies/classify.js',
    'domains/plugin/policies/market-entry.js',
  ],

  exempt: {
    hooks: 'onNativeRestart 为 supervisor 注入的出站回调（非域内跨文件 this）',
  },
};
