'use strict';

// app/assembly/compose.js —— 编排层组装门面（唯一知道全局对象图、唯一发生 DI 的地方）。
// 只做组合与编排，按固定顺序调用三个切面组（单向 facade -> steps，步骤不回 require 本文件）：
//   installFacets（切面装配）-> composeCore（宿主/基础设施）-> composeDomains（各域构造）
//     -> composeObservers（实例事件接线 + 生命周期注册）。

const { installFacets } = require('./facets');
const { composeCore } = require('./compose/core');
const { composeDomains } = require('./compose/domains');
const { composeObservers } = require('./compose/observers');

function composeSystem(host, rawConfig, configPath, deps) {
  installFacets(host, deps);
  composeCore(host, rawConfig, configPath);
  composeDomains(host);
  composeObservers(host);
  return host;
}

module.exports = { composeSystem };
