'use strict';

// api/router-table —— 域注册表：createServer 只负责遍历分派，新增/删除域只动本文件。
//
// 顺序即优先级：每域 owns() 是粗前缀超集，域内未匹配由该域 handle 兜底 404/405。
// 顺序必须与历史行为一致，改动顺序会改变路由归属。

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
  require('./domains/shell'),   // 桌面壳更新安全网（/shell/*）
];

module.exports = { API_DOMAINS };
