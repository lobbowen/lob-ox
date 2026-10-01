'use strict';

// router 域契约声明（纯数据，零 require）。
// exports=index.js 的 module.exports 字面量键；PUBLIC_API=对外契约面（消费方成员必须属于该表）；
// deps.hooks=hooks 出处；pure=零 IO require 的纯文件；exempt=合法例外。

module.exports = {
  domain: 'router',

  exports: ['RouterService'],

  // 域间契约（消费方成员必须属于本表；含 static presets 与冻结的 providers getter）
  PUBLIC_API: [
    // 生命周期
    'start', 'stop', 'stopAndWait', 'stopAllInstances',
    // 视图
    'status', 'domainSummary', 'portsView', 'listProviders',
    // 供应商/账号注册表
    'addDirectProvider', 'addProxyProvider', 'removeProvider', 'getProvider',
    'handleForProvider', 'activateProvider', 'deactivateProvider',
    // 写权闸 / 读体
    'canPersist', 'setPersistEnabled', 'readBody', 'log',
    // 转发 / 用量
    'proxyFor', 'getUsage', 'recordUsage', 'recordError',
    // 运维门面（aux）
    'commandcodeLoginStart', 'commandcodeLoginWait', 'proxyApps',
    'refreshProxyUpdateInfo', 'applyProxyUpdate', 'proxyUpdateStatus',
    'refreshOfficialUsageAll', 'refreshProviderQuota', 'refreshOfficialPricingAll',
    'setProviderKeys', 'setSelectedProxyKey', 'switchToKey',
    'removeProxyKey', 'addProxyKey', 'discardAccount',
    // 静态 / getter
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

  // 纯文件（src 相对全路径）：判定 / 构造 / 模型，均无 IO require
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

  // 合法例外：登记抽象契约占位的出处
  exempt: {
    // base 内 this.detectAccount 由该抽象占位豁免；池能力面契约在 providers/process-pool.js
    // mixin 声明并实现，基座无其他占位。
    'providers/base.js': '1 个抽象契约占位（detectAccount，must be implemented by subclass）',
  },
};
