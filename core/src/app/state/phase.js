'use strict';

// 主实例（受管对象 dsh:main）的相位映射：STOPPED / STARTING / RUNNING / FAILED。
// STARTING = 仍在 startsecs 窗口内（无论是否已经 spawn）。没有 RESTARTING / BACKOFF：
// 重启就是回到 STARTING（新窗口），限流到点就是 FAILED。
// 旧状态文件里可能残留 restarting/backoff 两个登记相位，读取时归一到新集合（迁移兼容）。
function legacyToEntryPhase(ph) {
  return {
    STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', FAILED: 'failed', OBSERVED: 'stopped',
    RESTARTING: 'starting', BACKOFF: 'failed',
  }[ph] || 'stopped';
}

function entryToLegacyPhase(ph) {
  return {
    stopped: 'STOPPED', starting: 'STARTING', running: 'RUNNING', failed: 'FAILED',
    restarting: 'STARTING', backoff: 'FAILED',
  }[ph] || 'STOPPED';
}

module.exports = { legacyToEntryPhase, entryToLegacyPhase };
