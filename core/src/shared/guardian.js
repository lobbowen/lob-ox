'use strict';

function shouldGuard(inst) {
  return !!(inst && inst.guardian === true);
}

// 启动失败限流（全域唯一一条策略、唯一一份实现，按域参数化窗口/次数）：
//   windowMs 内累计 burst 次「启动窗口内的失败」⇒ tripped。
// 没有退避阶梯、没有等级、没有等待曲线：到点即 FAILED（停止自动重启，等人工重试），否则立刻重试。
// 消费者（同一原语，两处调用点）：
//   * 主链 app/main/startup-throttle.js#_noteStartupFailure（窗口/次数取自 config.startupFailWindowMs/Burst）
//   * 实例域 domains/instance/state-machine.js#restart（窗口/次数取自 deps.throttle / 域缺省）
// 任何一方都不得再实现一份「看起来一样」的判定：新增域只允许传不同的 { windowMs, burst }。
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

module.exports = { shouldGuard, bumpStartupFailure };
