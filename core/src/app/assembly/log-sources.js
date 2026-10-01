'use strict';

// 日志汇聚「业务源」名单：platform 只提供源注册接口、不得出现业务域名词，名单在编排层声明。
// require 即注入（顶层副作用）：compose/core.js 必须在构造 LogCore 之前 require 本模块，名单先于
//   EventHub 构造就位；未注入时（直接 require platform/log/hub）EventHub 只认本进程本地源，不猜业务源名。

const hub = require('../../platform/service/log/hub');

// 聚合源字段：name = 聚合流 source / 水位键 / ctl 拉取身份；key = 装配短键（ctlPorts、daemonLogs、
//   /logs/tail stream 用它）；local true = 本进程本地推源（守卫自身），不参与 ctl 拉取。
const SOURCES = [
  { name: 'guard', key: 'guard', local: true },
  { name: 'router-daemon', key: 'router' },
  { name: 'lan-daemon', key: 'lan' },
];

// 内部簿记事件类型：进审计、不进默认用户时间线。
const INTERNAL_TYPES = ['router_daemon_supervised', 'orphan_audit'];

hub.setSources(SOURCES);
hub.setInternalTypes(INTERNAL_TYPES);
