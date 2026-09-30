'use strict';

// router 域端口段/独立池申报（反转法，DS-G4：platform 源码去注释后不得出现业务域名词）。
// platform/service/ports 只保留通用机制（物理池 + 分配算法 + 注册接口），段名与独立池是域知识、在此申报。
// require 即申报（模块缓存保证幂等）；由本域各入口 require，确保消费前已就位；
// 未申报段回退通用池 managed，与迁出前行为一致。

const ports = require('../../platform/service/ports');

/** router 域独立池。base/count 为历史字面量，端口迁移兼容性要求逐字不得改动。 */
const POOLS = {
  providerApi: { base: 24000, count: 2000 },  // 每供应商独立 API 端点段（24000-25999）
};

/** 逻辑段到物理池映射。anchor = 池内显式起点（与申报顺序无关）；值同 POOLS，不得改动。 */
const SEGMENTS = {
  proxyInstance: { pool: 'managed', anchor: 1000 },
  oauthCallback: { pool: 'managed', anchor: 2000 },
  providerApi: { pool: 'providerApi', anchor: 0 },
};

/** 本域自治段在共享注册表 owner 字段上的前缀（端口段迁出/清理的判据）。 */
const OWNER_PREFIXES = ['proxy:', 'providerApi:'];

ports.registerPools(POOLS);
ports.registerSegment(SEGMENTS);

module.exports = { POOLS, SEGMENTS, OWNER_PREFIXES };
