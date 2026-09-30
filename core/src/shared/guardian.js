'use strict';

// 守护决策（纯函数，不触碰进程/实例/系统服务）。默认关：仅 guardian===true 才自动拉起。

function shouldGuard(inst) {
  return !!(inst && inst.guardian === true);
}

/** 崩溃窗口 + 退避：窗口内累计到 crashBurst 次则升一级退避并给出 backoffUntil。 */
function bumpCrashWindow(cw, now, cfg) {
  let start = cw.start;
  let restarts = cw.restarts;
  if (start === null || now - start > cfg.crashWindowMs) {
    start = now;
    restarts = 1;
  } else {
    restarts += 1;
  }
  if (restarts >= cfg.crashBurst) {
    const level = Math.min((cfg.backoffLevel || 0) + 1, cfg.backoff.length - 1);
    return { start, restarts, backoffLevel: level, backoffUntil: now + cfg.backoff[level], backoffEntered: true };
  }
  return { start, restarts, backoffLevel: cfg.backoffLevel || 0, backoffUntil: null, backoffEntered: false };
}

/** 实例重启等待决策：60s 内失败过则线性退避（上限 60s），否则立即重试。 */
function instanceRestartDecision(state, now) {
  const crashesQuickly = !!(state.lastFailAt && now - state.lastFailAt < 60000);
  return {
    waitMs: crashesQuickly ? Math.min(60000, 5000 * ((state.backoffLevel || 0) + 1)) : 0,
    nextBackoffLevel: (state.backoffLevel || 0) + 1,
  };
}

module.exports = { shouldGuard, bumpCrashWindow, instanceRestartDecision };
