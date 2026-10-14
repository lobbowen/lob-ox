'use strict';

module.exports = {
  domain: 'shell',

  exports: [
    'status', 'evaluate', 'health', 'markPending', 'identity', 'readJournal', 'shellDir',
  ],

  PUBLIC_API: [
    'status', 'evaluate', 'health', 'markPending', 'identity', 'readJournal', 'shellDir',
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
