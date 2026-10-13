'use strict';

const stateRoot = require('../../platform/service/state-root');
const { normalize } = require('../../platform/service/config');
const SHARED = require('../../shared/shared-constants');
const { LanManager } = require('./ops');
const ports = require('../../platform/service/ports').shared;
// 与 router 共用一份引导骨架（状态目录/logcore.init/ctl server/信号与异常记账），
// 见 app/daemons/bootstrap.js。停机流程本体现留在下方——relay 要等 frpc 退出，
// 顺序敏感，骨架不接管。
const bootstrap = require('../../app/daemons/bootstrap');

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_CTL_PORT = SHARED.net.lanCtlPort;
const POLL_MS = 2000;
const LABEL = 'lan-daemon';

const LAN_CTL_METHODS = Object.freeze([
  'list', 'frpStatus', 'frpAction', 'syncFrpc',
  'eventsTail',
]);

function loadConfig() {
  const cfgPath = process.argv.indexOf('-c') >= 0
    ? process.argv[process.argv.indexOf('-c') + 1]
    : (process.env.DSH_SUPERVISOR_CONFIG || path.join(stateRoot.supervisorDir(), 'config.json'));
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return { cfgPath, ...normalize(raw) };
}

function main() {
  const config = loadConfig();
  const swDir = bootstrap.resolveStateDir(config);
  const stateFile = path.join(swDir, 'lan-state.json');
  
  
  const core = bootstrap.initLog({
    config,
    process: 'lan-daemon',
    logFileKey: 'lanLogFile',
    eventFileKey: 'lanEventsFile',
    logFileName: 'lan-daemon.log',
    eventFileName: 'lan.events.log',
    stateDir: swDir,
  });
  const events = core.events;
  const logger = core.logger;
  try { ports.migrateByOwnerPrefix(path.join(swDir, 'ports-lan.json'), path.join(swDir, 'ports.json'), ['relay:']); }
  catch (e) { logger.warn && logger.warn('ports-lan 迁移: ' + (e && e.message)); }
  try { ports.configureFile(path.join(swDir, 'ports.json'), { siblingFiles: [path.join(swDir, 'ports-router.json'), path.join(swDir, 'ports-lan.json')] }); } catch {}

  let snapshot = { instances: [], tokens: {}, mtime: 0, textHash: '' };
  const lanSource = {
    instances: [],
    save() {  },
    all() { return this.instances; },
  };

  const lan = new LanManager({
    configPath: config.cfgPath,
    stateDir: swDir,
    logger,
    events,
    instances: lanSource,
    tokenOf: (id) => snapshot.tokens[id] || '',
  });

  const reload = () => {
    try {
      const st = fs.statSync(stateFile);
      if (st.mtimeMs === snapshot.mtime) return false;
      const text = fs.readFileSync(stateFile, 'utf8');
      const doc = JSON.parse(text);
      const next = {
        mtime: st.mtimeMs,
        textHash: text,
        instances: Array.isArray(doc.instances) ? doc.instances : [],
        tokens: (doc.tokens && typeof doc.tokens === 'object') ? doc.tokens : {},
      };
      const changed = next.textHash !== snapshot.textHash;
      snapshot = next;
      if (!changed) return false;
      lanSource.instances.length = 0;
      for (const inst of snapshot.instances) {
        lanSource.instances.push({
          id: inst.id,
          name: inst.name || inst.id,
          port: inst.port,
          remoteMode: inst.remoteMode === 'lan' || inst.remoteMode === 'wan' ? inst.remoteMode : 'off',
          remoteToken: inst.remoteToken || '',
        });
      }
      if (snapshot.tokens) {
        for (const id of Object.keys(snapshot.tokens)) {
          try { lan.applyToken(id); } catch {}
        }
      }
      return true;
    } catch (e) {
      if (e && e.code !== 'ENOENT') logger.warn('[lan-daemon] 状态读取异常: ' + (e && e.message));
      return false;
    }
  };

  let changedLast = false;
  const tick = () => {
    try {
      const changed = reload();
      lan.reconcile().catch((e) => logger.warn && logger.warn('[lan-daemon] reconcile: ' + ((e && e.stack) || e)));
      if (changed || changedLast) {
        try { lan.syncFrpc(); } catch {}
      }
      changedLast = changed;
    } catch (e) {
      logger.warn('[lan-daemon] tick: ' + (e && e.message));
    }
  };

  tick();
  const timer = setInterval(tick, POLL_MS);

  const ctlPort = Number(config.lanCtlPort) || DEFAULT_CTL_PORT;
  const ctl = bootstrap.startCtl({
    target: lan,
    allowMethods: LAN_CTL_METHODS,
    port: ctlPort,
    label: LABEL,
    logger,
    events,
    onListening: () => logger.info('[lan-daemon] ctl listening on 127.0.0.1:' + ctlPort),
    onListenError: (e) => logger.error('[lan-daemon] ctl 监听失败(' + ctlPort + '): ' + e.message),
  });

  events.append('lan_daemon_started', { pid: process.pid });
  logger.info('[lan-daemon] started pid=' + process.pid + ' state=' + stateFile);

  const waitFrpcExit = (child) => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null || Date.now() - t0 > 3500) { clearInterval(iv); resolve(); }
    }, 100);
    if (iv.unref) iv.unref();
    setTimeout(resolve, 4000).unref();
  });
  let _exiting = false;
  const shutdown = (code) => {
    if (_exiting) { process.exit(code || 0); }
    _exiting = true;
    logger.info('[lan-daemon] shutting down');
    try { clearInterval(timer); } catch {}
    try { ctl.close(); } catch {}
    let frpc = null;
    try { frpc = lan && lan.frpChild ? lan.frpChild() : null; } catch {}
    try { lan.shutdown(); } catch {}
    void waitFrpcExit(frpc).then(() => {
      if (frpc && frpc.exitCode === null) logger.warn('[lan-daemon] frpc 未在窗口内退出（已发 SIGKILL）');
      try { events.append('lan_daemon_stopped', {}); } catch {}
      process.exit(code || 0);
    });
  };
  bootstrap.installProcessHandlers({ label: LABEL, logger, shutdown });
}

if (require.main === module) main();
