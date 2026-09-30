'use strict';

const { RouterService } = require('./index');
const { DistributionManager } = require('../../platform/distribution/index');
const { TaskRegistry } = require('../../platform/service/tasks');
const stateRoot = require('../../platform/service/state-root');
const { guardVersion } = require('../../platform/service/version');
const hub = require('../../platform/service/log/hub');
const logcore = require('../../platform/service/log/logcore');
const { createCtlServer } = require('../../platform/ctl/server');

// router-daemon —— 智能路由独立进程（L3 进程解耦）。仅装配 + 启动，零业务判断。
// 运行：node src/domains/router/daemon.js [-c <configPath>]。ctl 白名单见 ./config。
// 共享文件写权独占：providers.json / router-usage-totals.json / ports-router.json（config.json 只读）。

const path = require('node:path');
const { DEFAULT_CTL_PORT, ROUTER_CTL_METHODS, loadConfig } = require('./config');
const { ensurePorts } = require('./ports-bootstrap');

function main() {

  const config = loadConfig();
  const swDir = config.stateFile ? path.dirname(path.resolve(config.stateFile)) : stateRoot.supervisorDir();
  // 本进程自行声明日志汇聚源：域名词留在域内，避免 domains -> app 上行依赖。
  hub.registerSource("router-daemon", { key: "router" });
  const core = logcore.init({
    process: 'router-daemon',
    logFile: config.routerLogFile || path.join(swDir, 'log', 'router-daemon.log'),
    eventFile: config.routerEventsFile || path.join(swDir, 'events', 'router.events.log'),
    logLevel: config.logLevel || 'info',
    logMaxBytes: config.logMaxBytes,
    eventsMaxBytes: config.eventsMaxBytes,
  });
  const events = core.events;
  const logger = core.logger;
  const dist = new DistributionManager({
    registries: (config.registries && config.registries.length) ? config.registries : ['https://registry.npmjs.org'],
    registryFile: path.join(swDir, 'registry.json'),
    // 选择文档在此进程只读：本 daemon 的 ctl 方法表里没有镜像写入口，写它的是守卫面板那条路径。
    registryChoiceFile: path.join(swDir, 'registry-choice.json'),
    events,
    logger,
  });
  const tasks = new TaskRegistry({ stateDir: swDir, logger, events });

  // 端口迁移 + 按 providers 重建必须在 RouterService 构造之前（ports-bootstrap）：
  // 构造后执行会以内存空表覆盖历史绑定，真实数据丢失。
  ensurePorts({ swDir, logger });

  const router = new RouterService({
    config,
    providerFile: path.join(swDir, 'providers.json'),
    usageTotalsFile: path.join(swDir, 'router-usage-totals.json'),
    portsFile: path.join(swDir, 'ports-router.json'),
    logger,
    events,
    dist,
    tasks,
  });

  // 守卫控制通道：白名单按域注入（PG-5），内部方法永不可达；通用 dispatcher 见 platform/ctl/server.js。
  const ctlPort = Number(config.routerCtlPort) || DEFAULT_CTL_PORT;
  const ctl = createCtlServer({ target: router, allowMethods: ROUTER_CTL_METHODS, logger, events });
  ctl.listen(ctlPort, '127.0.0.1', () => {
    logger.info('[router-daemon] ctl listening on 127.0.0.1:' + ctlPort);
  });
  ctl.on('error', (e) => {
    logger.error('[router-daemon] ctl listen failed (' + ctlPort + '): ' + e.message + '（守卫监督模式将无法转发 router 控制）');
  });

  events.append('router_daemon_started', { pid: process.pid, version: guardVersion() });
  logger.info('[router-daemon] started pid=' + process.pid);

  router.start().then((r) => {
    if (r && r.ok === false) {
      logger.error('[router-daemon] 启动失败: ' + (r.error || '未知'));
      process.exit(1);
    }
    logger.info('[router-daemon] 就绪（供应商端点按 activated 监听）');
  }).catch((e) => {
    logger.error('[router-daemon] 启动异常: ' + ((e && e.stack) || e));
    process.exit(1);
  });

  // 优雅退出：SIGTERM 时停 router 并确认实例子进程已死再退出，防停服遗留孤儿进程。
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('[router-daemon] shutting down');
    try { await router.stopAndWait(5000); } catch (e) { logger.error('[router-daemon] 停实例异常: ' + ((e && e.message) || e)); }
    try { events.append('router_daemon_stopped', {}); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (e) => {
    logger.error('[router-daemon] uncaughtException: ' + ((e && e.stack) || e));
  });
  process.on('unhandledRejection', (e) => {
    logger.error('[router-daemon] unhandledRejection: ' + (e && (e.stack || e.message) || e));
  });
}

// 入口守卫：直接运行才启动。裸调 main() 会让 require 本文件（测试/工具/静态分析）立即拉起真实 daemon。
if (require.main === module) main();
