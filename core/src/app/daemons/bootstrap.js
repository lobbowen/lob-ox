'use strict';

// daemon 进程标准骨架的公共部分。router/relay 两个 daemon 各自实现过一套完全同构的
// 引导流程：读配置 → 定状态根目录 → logcore.init → 起 ctl server → 记 started 事件
// → 装 SIGTERM/SIGINT 优雅停机 + uncaughtException/unhandledRejection 记账。
// 这里只承载**与业务无关**的那几段；差异部分（领域对象装配、启动失败退出、停机时
// 还要等 frpc 退出等）仍由各 daemon 自己在原位置、按原顺序执行——骨架不接管顺序，
// 因此抽出后行为逐字节一致。
//
// 刻意不抽的部分：
//   - 停机流程本体（router 的 stopAndWait / relay 的 waitFrpcExit）：顺序敏感，
//     交回给调用方，本模块只负责把信号接到调用方的回调上。
//   - 启动成功后的就绪判定与 exit(1)：每个 daemon 的失败语义不同。

const path = require('node:path');
const stateRoot = require('../../platform/service/state-root');
const logcore = require('../../platform/service/log/logcore');
const { createCtlServer } = require('../../platform/ctl/server');

// 配置里给了 stateFile 就以它为准，否则回落到 supervisor 目录。
// 两个 daemon 原先各自内联这一行——与 loadConfig 放哪儿无关，故可安全收口。
function resolveStateDir(config) {
  const c = config || {};
  return c.stateFile
    ? path.dirname(path.resolve(c.stateFile))
    : stateRoot.supervisorDir();
}

// logcore.init 的参数装配。日志/事件文件的默认值拼法与 daemon 名绑定
// （'log'/'events' 子目录 + <process>.log），两个 daemon 完全一致。
function initLog({ config, process: procName, logFileKey, eventFileKey, logFileName, eventFileName, stateDir }) {
  const cfg = config || {};
  return logcore.init({
    process: procName,
    logFile: cfg[logFileKey] || path.join(stateDir, 'log', logFileName),
    eventFile: cfg[eventFileKey] || path.join(stateDir, 'events', eventFileName),
    logLevel: cfg.logLevel || 'info',
    logMaxBytes: cfg.logMaxBytes,
    eventsMaxBytes: cfg.eventsMaxBytes,
  });
}

// ctl server：绑 127.0.0.1 + 监听回调 + 监听失败只记日志不退出。
// 两个 daemon 都把「守卫监督模式转发不了控制」这件事吞掉，故这里不 rethrow。
function startCtl({ target, allowMethods, port, label, logger, events, onListening, onListenError }) {
  const ctl = createCtlServer({ target, allowMethods, logger, events });
  ctl.listen(port, '127.0.0.1', () => {
    if (onListening) onListening();
    else logger.info('[' + label + '] ctl listening on 127.0.0.1:' + port);
  });
  ctl.on('error', (e) => {
    if (onListenError) onListenError(e);
    else logger.error('[' + label + '] ctl 监听失败(' + port + '): ' + e.message);
  });
  return ctl;
}

// 信号与异常记账。shutdown 由调用方提供，骨架不决定它做什么、也不决定何时退出，
// 因此 relay「停机后再等 frpc 退出」与 router「stopAndWait(5000) 后 exit(0)」
// 都能原样保留——差别只落在回调体里。
function installProcessHandlers({ label, logger, shutdown }) {
  const onSig = () => shutdown(0);
  process.on('SIGTERM', onSig);
  process.on('SIGINT', onSig);
  process.on('uncaughtException', (e) => {
    logger.error('[' + label + '] uncaughtException: ' + ((e && e.stack) || e));
  });
  process.on('unhandledRejection', (e) => {
    logger.error('[' + label + '] unhandledRejection: ' + ((e && (e.stack || e.message)) || e));
  });
}

module.exports = { resolveStateDir, initLog, startCtl, installProcessHandlers };
