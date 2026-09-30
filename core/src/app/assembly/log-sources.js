'use strict';

// app/assembly/log-sources.js —— 日志汇聚「业务源」声明（DS-G4 反转法注入点）：platform 不得出现业务域名词，EventHub 只提供源注册接口，源名单在本文件（编排层）声明。
// require 即注入（模块顶层副作用）：组装核（compose/core.js）必须在构造 LogCore 之前 require 本模块，让名单先于 EventHub 构造就位；Node 模块缓存保证只注入一次。
// 未注入时（单测直接 require platform/log/hub）EventHub 只认本进程本地源，不猜业务源名。

const hub = require('../../platform/service/log/hub');

// 聚合源字段：name = 聚合流 source 字段 / 水位键 / ctl 拉取身份；
//   key = 装配短键（ctlPorts / daemonLogs / /logs/tail stream 都用它）；
//   local true = 本进程本地推源（守卫自身），不参与 ctl 拉取。
const SOURCES = [
  { name: 'guard', key: 'guard', local: true },
  { name: 'router-daemon', key: 'router' },
  { name: 'lan-daemon', key: 'lan' },
];

// 内部簿记事件类型：进审计、不进默认用户时间线。
const INTERNAL_TYPES = ['router_daemon_supervised', 'orphan_audit'];

hub.setSources(SOURCES);
hub.setInternalTypes(INTERNAL_TYPES);
