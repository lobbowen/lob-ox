'use strict';

// 编排层组装门面：唯一知道全局对象图、唯一发生 DI 的地方。
// 只做组合与编排，按固定顺序调用 installFacets -> composeCore -> composeDomains -> composeObservers；
//   切面各步单向依赖 facade，不回 require 本文件。

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
