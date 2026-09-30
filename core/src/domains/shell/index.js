'use strict';

// 壳更新安全网域门面（只做组合与导出，不实现业务）：journal=账本/状态机/健康上报，
// restart=版本检测/壳重启，watchdog=壳缺失看护（由 supervisor 直接引用）。
// 导出面必须逐字保持：supervisor.js 消费下列全部符号；watchdog 经 deps.shell 消费
// identity/readJournal/restartShell。少一个即运行期 undefined。

const {
  shellDir,
  identity,
  readJournal,
  markPending,
  evaluate,
  health,
  status,
} = require('./journal');

const { SHELL_RELEASE_PKG, checkUpdate, restartShell } = require('./restart');

module.exports = { status, evaluate, health, markPending, identity, readJournal, shellDir, checkUpdate, restartShell, SHELL_RELEASE_PKG };
