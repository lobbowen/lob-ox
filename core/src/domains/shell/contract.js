'use strict';

module.exports = {
  domain: 'shell',

  exports: [
    'status', 'evaluate', 'health', 'markPending', 'identity', 'readJournal', 'shellDir', 'checkUpdate',
  ],

  PUBLIC_API: [
    'status', 'evaluate', 'health', 'markPending', 'identity', 'readJournal', 'shellDir', 'checkUpdate',
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
