'use strict';

const stateRoot = require('../../platform/service/state-root');
const { normalize } = require('../../platform/service/config');
const { LanManager } = require('./ops');
const ports = require('../../platform/service/ports').shared;
const { createCtlServer } = require('../../platform/ctl/server');
const hub = require('../../platform/service/log/hub');
const logcore = require('../../platform/service/log/logcore');

// lan-daemon：远程控制（relay/frpc）独立进程（L3b 进程解耦）。守卫只在 config.lanDaemon=true 时 spawn detached 并监测/拉起本进程
// （调试也可直接 node src/domains/relay/daemon.js -c <configPath>）；守卫重启/停止不影响已有 relay/frpc，只短暂影响新增与变更对账。
// 数据流（松耦合）：守卫写 <stateDir>/lan-state.json（原子 0600），本进程 2s 轮询 diff 后 reconcile，令牌变化经 lan.applyToken 热换 cookie；frp.json/frpc.toml 由本进程独占写（守卫经 ctl 委托读写）；端口与守卫共写注册表 <stateDir>/ports.json（B2-5 单源：读路径 mtime+size 对时、分配临界区持 .alloc.lock，第二本账 ports-lan.json 已废止并一次性迁移）；ctl 只听 127.0.0.1:43108。

const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_CTL_PORT = 43108;
const POLL_MS = 2000;

// lan 域 ctl 白名单（PG-5）：白名单是域知识，须由本域自带——否则共用 dispatcher 时本进程 ctl 端口
// 能调到 router 的方法（反之亦然），扩大攻击面。eventsTail 是 dispatcher 内置特例，须显式登记。
const LAN_CTL_METHODS = Object.freeze([
  'list', 'frpStatus', 'frpAction', 'syncFrpc',
  'eventsTail',
]);

function loadConfig() {
  const cfgPath = process.argv.indexOf('-c') >= 0
    ? process.argv[process.argv.indexOf('-c') + 1]
    : (process.env.DSH_SUPERVISOR_CONFIG || path.join(stateRoot.supervisorDir(), 'config.json'));
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // DS-G4（反转法）：platform 的 DEFAULTS 不含业务域键（lanCtlPort 等），故本进程用域常量
  // DEFAULT_CTL_PORT 兜底；domains 反向依赖 app/编排层属非法边（L-2）。
  return { cfgPath, ...normalize(raw) };
}

function main() {
  const config = loadConfig();
  const swDir = config.stateFile ? path.dirname(path.resolve(config.stateFile)) : stateRoot.supervisorDir();
  const stateFile = path.join(swDir, 'lan-state.json');
  // 每个进程只注册自己那一个日志源，守卫进程（compose.js）再注册全部源做汇聚。
  // 不能 require app/assembly/log-sources：那是 domains 到 app 的上行依赖（DS-3 禁止）。
  hub.registerSource("lan-daemon", { key: "lan" });
  const core = logcore.init({
    process: 'lan-daemon',
    logFile: config.lanLogFile || path.join(swDir, 'log', 'lan-daemon.log'),
    eventFile: config.lanEventsFile || path.join(swDir, 'events', 'lan.events.log'),
    logLevel: config.logLevel || 'info',
    logMaxBytes: config.logMaxBytes,
    eventsMaxBytes: config.eventsMaxBytes,
  });
  const events = core.events;
  const logger = core.logger;
  // 端口注册表单源（B2-5）：先一次性迁移老部署的 ports-lan.json（owner=relay:* 并进 ports.json，
  // 幂等；顺序必须在 configureFile 之前——重载后内存即含迁移结果），再指向与守卫同一本账。
  try { ports.migrateByOwnerPrefix(path.join(swDir, 'ports-lan.json'), path.join(swDir, 'ports.json'), ['relay:']); }
  catch (e) { logger.warn && logger.warn('ports-lan 迁移: ' + (e && e.message)); }
  try { ports.configureFile(path.join(swDir, 'ports.json')); } catch {}

  // 实例源是文件快照的投影 { instances, save:noop }：wanPort 绑定权威只在端口注册表，快照不含端口字段。
  let snapshot = { instances: [], tokens: {}, mtime: 0, textHash: '' };
  const lanSource = {
    instances: [],
    save() { /* binding 只活在注册表，不回写守卫的 instances.json */ },
    // 与 instance 域契约同形：relay/managed.js 只经 all() 取清单（DG-11），不直读内部数组。
    // all() 返回的即下面这个活数组，reload 靠就地替换生效。
    all() { return this.instances; },
  };

  const lan = new LanManager({
    configPath: config.cfgPath, // 端口回收按 configPath 精确匹配（RC6）
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
      // 替换实例快照（LanManager.reconcile 以 port 关联已有代理：增删/启停经 reconcile 收敛）
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
      // 令牌 diff：热换既有 relay cookie（无 relay 时仅刷新 tokenOf 供后续会话使用）
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
      lan.reconcile().catch((e) => logger.warn && logger.warn('[lan-daemon] reconcile: ' + ((e && e.stack) || e))); // async（TCP 可达判定）
      if (changed || changedLast) {
        try { lan.syncFrpc(); } catch {}
      }
      changedLast = changed;
    } catch (e) {
      logger.warn('[lan-daemon] tick: ' + (e && e.message));
    }
  };

  // 立即读一次（守卫可能在 spawn 前已写好状态），随后周期性对账
  tick();
  const timer = setInterval(tick, POLL_MS);

  const ctl = createCtlServer({ target: lan, allowMethods: LAN_CTL_METHODS, logger, events });
  const ctlPort = Number(config.lanCtlPort) || DEFAULT_CTL_PORT;
  ctl.listen(ctlPort, '127.0.0.1', () => logger.info('[lan-daemon] ctl listening on 127.0.0.1:' + ctlPort));
  ctl.on('error', (e) => logger.error('[lan-daemon] ctl 监听失败(' + ctlPort + '): ' + e.message));

  events.append('lan_daemon_started', { pid: process.pid });
  logger.info('[lan-daemon] started pid=' + process.pid + ' state=' + stateFile);

  // 优雅停机必须等 frpc 真退出（或 3.5s 兜底）再 exit：lan.shutdown()/frp.stop() 是同步的，只发
  // SIGTERM 就返回，其 SIGKILL 兜底靠内部 250ms 定时器——紧接着 process.exit() 会掐掉该定时器，
  // 忽略 SIGTERM 的 frpc 就成孤儿并继续占住公网隧道端口。
  // child 句柄须在 lan.shutdown() 之前捕获传入：frp.stop() 会先把 this.child 置 null。
  const waitFrpcExit = (child) => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null || Date.now() - t0 > 3500) { clearInterval(iv); resolve(); }
    }, 100);
    if (iv.unref) iv.unref();
    // 兜底：即便轮询异常，也不能让进程永不退出
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
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('uncaughtException', (e) => logger.error('[lan-daemon] uncaughtException: ' + ((e && e.stack) || e)));
  process.on('unhandledRejection', (e) => logger.error('[lan-daemon] unhandledRejection: ' + ((e && (e.stack || e.message)) || e)));
}

// 入口守卫：require 时不得启动真实 daemon（与 router/daemon 一致）。
if (require.main === module) main();
