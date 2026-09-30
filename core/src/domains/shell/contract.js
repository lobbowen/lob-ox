'use strict';

// shell 域契约声明（纯数据，零 require）。exports/PUBLIC_API 为逐字冻结的导出面
//（消费方 supervisor.js / watchdog deps.shell），pure 标记零 require 汇点 core.js。

module.exports = {
  domain: 'shell',

  exports: [
    'status', 'evaluate', 'health', 'markPending', 'identity',
    'readJournal', 'shellDir', 'checkUpdate', 'restartShell', 'SHELL_RELEASE_PKG',
  ],

  PUBLIC_API: [
    'status', 'evaluate', 'health', 'markPending', 'identity',
    'readJournal', 'shellDir', 'checkUpdate', 'restartShell', 'SHELL_RELEASE_PKG',
  ],

  classApi: {},

  deps: {
    logger: '日志器',
    events: '事件账本',
    dist: '统一分发（npm 版本查询）',
  },

  hooks: {},

  pure: ['domains/shell/core.js'],

  exempt: {},
};
