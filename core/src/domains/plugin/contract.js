'use strict';

// plugin 域契约声明（纯数据，零 require）。
// exports/PUBLIC_API/exports.keys 对应 index.js 导出面与全仓消费面；
// deps.hooks 与 exempt.hooks 为 onNativeRestart 的 DG-4b 豁免出处；
// pure 为零 IO require 的纯文件清单。

module.exports = {
  domain: 'plugin',

  exports: ['PluginManager', 'PluginMarket', 'PROTECTED'],

  PUBLIC_API: [
    // PluginManager（api/domains/plugins.js 消费）
    'resolveTargets', 'installedOn', 'inventory', 'readManifest', 'overlayEntries',
    'listInstalled', 'setBundleEnabled', 'saveOverlayEntries',
    'install', 'uninstall', 'installStatus', 'checkUpdates', 'update',
    // PluginMarket（api/domains/plugins.js 消费 getIndex）
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

  // 纯文件（src 相对全路径，门禁按 e.rel 查表）：model/policies 决定与构造均无 IO
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
