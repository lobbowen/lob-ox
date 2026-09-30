'use strict';

// relay 域端口段声明（DS-G4 反转法）：platform 源码（去注释）不得出现业务域名词，故 relay 段作为域知识在此申报，
// platform 只提供通用池与分配算法。require 即申报（顶层副作用，模块缓存保证幂等）；
// 未申报的段回退通用池，而 relay 本就落在该池，故漏申报不改变行为。

const ports = require('../../platform/service/ports');

/** 逻辑段到物理池：relay 与反代实例/回调共用 managed 共享池。 */
// anchor 是池内显式起点（与申报顺序无关）。
const SEGMENTS = {
  relay: { pool: 'managed', anchor: 0 },
};

ports.registerSegment(SEGMENTS);

// 本模块唯一对外契约是 require 即申报的副作用；SEGMENTS 无外部消费者。
module.exports = {};
