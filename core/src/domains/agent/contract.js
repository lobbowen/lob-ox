'use strict';

// agent 管理域契约。
//
// 定位：内核内**所有 agent 产品**的统一管理系统。DSH 是第一个被它管理的 agent，
// 但域不绑定 DSH——后续接入其他 agent（claude-code / codex 等）只需新增一个
// product 描述子，不新增域。
//
// 与旧 domains/instance 的关系：instance 混装了 DSH 管理与沙箱实例管理，
// 本域把「agent 管理」收拢过来，instance 只保留沙箱实例自身的东西。

module.exports = {
  domain: 'agent',

  exports: ['AgentManager'],

  PUBLIC_API: [
    // 形态与查询
    'kinds', 'capabilitiesOf', 'list', 'find', 'inventory',
    // 生命周期五件套（两种形态同一套代码，差异由 runtime 吸收）
    'install', 'uninstall', 'upgrade', 'start', 'stop', 'status',
    // 入口与数据落点
    'entryOf', 'dataDirOf', 'installDirOf',
    // 更新检查
    'checkUpdate', 'upgradeStatus',
  ],

  classApi: {
    AgentManager: [
      'kinds', 'capabilitiesOf', 'list', 'find', 'inventory',
      'install', 'uninstall', 'upgrade', 'start', 'stop', 'status',
      'entryOf', 'dataDirOf', 'installDirOf',
      'checkUpdate', 'upgradeStatus',
    ],
  },

  deps: {
    root: 'agent 数据根（<state>/agents）',
    dist: '统一分发（registry 查询 / npm install）',
    tasks: '统一安装/更新任务注册表',
    events: '事件账本',
    logger: '日志器',
    service: 'OS 服务控制（systemd / 服务管理器）',
    tokens: '令牌服务（会话捕获）',
    resstats: '进程树资源采样（platform/os/resstats；配额判定已按「共享系统资源」决策移除，此处只用于资源用量展示）',
  },

  pure: [
    'domains/agent/kinds.js',
    'domains/agent/model.js',
  ],
};