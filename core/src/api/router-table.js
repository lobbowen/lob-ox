'use strict';

const API_DOMAINS = [
  require('./domains/tasks'),
  require('./domains/lifecycle'),
  require('./domains/native'),
  require('./domains/guard'),
  require('./domains/router'),
  require('./domains/plugins'),
  require('./domains/dist'),
  require('./domains/instances'),
  require('./domains/relay'),
  require('./domains/shell'),
];

module.exports = { API_DOMAINS };
