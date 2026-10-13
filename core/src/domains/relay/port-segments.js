'use strict';

// 本文件仅作注册副作用：require 它即向端口权威登记 relay 的段定义。
// 导出为空对象是有意为之——没有任何东西需要从这里取数据，
// 消费方（relay/ports.js）只为触发注册而 require。

const ports = require('../../platform/service/ports');

const SEGMENTS = {
  relay: { pool: 'managed', anchor: 0 },
};

ports.registerSegment(SEGMENTS);

module.exports = {};
