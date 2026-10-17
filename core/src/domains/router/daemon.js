'use strict';
const { FALLBACK_REGISTRIES } = require('../../platform/distribution/policies');

const { RouterService } = require('./index');
const { DistributionManager } = require('../../platform/distribution/index');
const { TaskRegistry } = require('../../platform/service/tasks');
const { guardVersion } = require('../../platform/service/version');

const path = require('node:path');
const { DEFAULT_CTL_PORT, ROUTER_CTL_METHODS, loadConfig } = require('./config');
const { ensurePorts } = require('./ports-bootstrap');
// 引导骨架（读配置后的状态目录、logcore.init、ctl server、信号/异常记账）
// 与 relay 共用一份实现，见 app/daemons/bootstrap.js 的取舍说明。
const bootstrap = require('../../app/daemons/bootstrap');

const LABEL = 'router-daemon';

function main() {

  const config = loadConfig();
  const swDir = bootstrap.resolveStateDir(config);
  
  
  const core = bootstrap.initLog({
    config,
    process: 'router-daemon',
    logFileKey: 'routerLogFile',
    eventFileKey: 'routerEventsFile',
    logFileName: 'router-daemon.log',
    eventFileName: 'router.events.log',
    stateDir: swDir,
  });
  const events = core.events;
  const logger = core.logger;
  const dist = new DistributionManager({
    registries: (config.registries && config.registries.length) ? config.registries : FALLBACK_REGISTRIES,
    registryFile: path.join(swDir, 'registry.json'),
    registryChoiceFile: path.join(swDir, 'registry-choice.json'),
    events,
    logger,
  });
  const tasks = new TaskRegistry({ stateDir: swDir, logger, events });

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

  const ctlPort = Number(config.routerCtlPort) || DEFAULT_CTL_PORT;
  bootstrap.startCtl({
    target: router,
    allowMethods: ROUTER_CTL_METHODS,
    port: ctlPort,
    label: LABEL,
    logger,
    events,
    onListening: () => {
      logger.info('[router-daemon] ctl listening on 127.0.0.1:' + ctlPort);
    },
    onListenError: (e) => {
      logger.error('[router-daemon] ctl listen failed (' + ctlPort + '): ' + e.message + '（内核监督模式将无法转发 router 控制）');
    },
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('[router-daemon] shutting down');
    try { await router.stopAndWait(5000); } catch (e) { logger.error('[router-daemon] 停实例异常: ' + ((e && e.message) || e)); }
    try { events.append('router_daemon_stopped', {}); } catch {}
    process.exit(0);
  };
  bootstrap.installProcessHandlers({ label: LABEL, logger, shutdown });
}

if (require.main === module) main();
