'use strict';

function shouldGuard(inst) {
  return !!(inst && inst.guardian === true);
}

// 启动失败限流（唯一一条）：windowMs 内累计 burst 次「启动窗口内的退出」⇒ tripped。
// 没有退避阶梯、没有等级：到点即 FAILED（停止自动重启，等人工重试），否则立刻重试。
function bumpStartupFailure(w, now, cfg) {
  const windowMs = cfg && Number(cfg.windowMs) > 0 ? Number(cfg.windowMs) : 60000;
  const burst = cfg && Number(cfg.burst) >= 1 ? Number(cfg.burst) : 5;
  let start = w.start;
  let count = w.count;
  if (start === null || start === undefined || now - start > windowMs) {
    start = now;
    count = 1;
  } else {
    count += 1;
  }
  return { start, count, tripped: count >= burst };
}

// 实例（沙箱域）重启等待：60s 内失败过则线性退避（上限 60s），否则立即重试。
// 与内核主实例的存活监控无关，由 domains/instance 自行消费。
function instanceRestartDecision(state, now) {
  const crashesQuickly = !!(state.lastFailAt && now - state.lastFailAt < 60000);
  return {
    waitMs: crashesQuickly ? Math.min(60000, 5000 * ((state.backoffLevel || 0) + 1)) : 0,
    nextBackoffLevel: (state.backoffLevel || 0) + 1,
  };
}

module.exports = { shouldGuard, bumpStartupFailure, instanceRestartDecision };
