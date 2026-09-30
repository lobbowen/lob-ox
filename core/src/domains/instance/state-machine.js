'use strict';

// 运行状态机：相位转移 + 退避决策。纯函数；落盘/发事件/令牌经 deps = { events, logger, save, tokens } 显式入参（非隐式 this），
// 本模块只读写 inst.state 并调用 deps 回调，实际副作用由调用方（lifecycle 监督拍）实现。

const guardian = require('../../shared/guardian');

function setRunning(deps, inst, st, now) {
  const state = inst.state;
  state.phase = 'RUNNING';
  state.lastError = null;
  // 稳定运行后重置崩溃计数（时间窗语义）：距上次失败 >5 分钟视为已恢复稳定、清零 restartCount/backoffLevel；
  // 否则偶发重启会跨时间无限累计到 20 次上限触发永久 FAILED。
  if ((state.lastFailAt || 0) && now - state.lastFailAt > 5 * 60 * 1000) {
    if ((state.restartCount || 0) > 0 || (state.backoffLevel || 0) > 0) {
      state.restartCount = 0;
      state.backoffLevel = 0;
      state.lastFailAt = null;
    }
  }
  if (deps.events) deps.events.append('inst_running', { id: inst.id, name: inst.name, pid: st.pid });
  // 令牌捕获统一交令牌服务（journald 源）：「端口先起、URL 后打印」竞态与轮换重试由服务内策略覆盖，
  // 变化经服务 onChange 统一下发（relay 热换 cookie），实例侧不持有/不转发令牌。
  if (inst.domain === 'sandbox' && deps.tokens) {
    // 沙箱令牌源只登记 journald 单元、不登记 file（旧令牌缓存会 block journal，同 store.load 纪律）。
    deps.tokens.attach(inst.id, { unit: 'dsh-web@' + inst.id });
    deps.tokens.scheduleCapture(inst.id);
  }
}

/** 设置实例回到「停止」（未运行且未守护：不算失败，只是停着）。 */
function setStopped(deps, inst) {
  const state = inst.state;
  state.phase = 'STOPPED';
  state.lastError = null;
  if (deps.save) deps.save();
}

/** 实例失败（安装/启动失败）：进入 FAILED 并暴露原因，由用户手动重试；不无限自愈（避免白费资源）。 */
function fail(deps, inst, reason) {
  const state = inst.state;
  state.phase = 'FAILED';
  state.lastError = reason;
  if (deps.events) deps.events.append('inst_failed', { id: inst.id, name: inst.name, reason });
  if (deps.logger && deps.logger.error) deps.logger.error('instance ' + inst.name + ' FAILED: ' + reason);
  if (deps.save) deps.save();
}

/** 实例异常：进入退避（BACKOFF），到期由监督拍自动重试。始终带最小等待，避免紧循环打爆；
 *  超过最大重试次数则 FAILED（暴露原因，避免无限白忙）。 */
function restart(deps, inst, reason) {
  const state = inst.state;
  const attempts = (state.restartCount || 0) + 1;
  if (attempts > 20) {
    state.restartCount = attempts;
    fail(deps, inst, '重试超限(' + reason + ')');
    return;
  }
  state.phase = 'BACKOFF';
  state.restartCount = attempts;
  state.lastFailure = reason;
  const now = Date.now();
  const d = guardian.instanceRestartDecision(state, now);
  state.lastFailAt = now;
  state.backoffLevel = d.nextBackoffLevel;
  state.backoffUntil = now + Math.max(d.waitMs, 5000); // 至少 5s，防紧循环
  if (deps.events) deps.events.append('inst_restarted', { id: inst.id, name: inst.name, reason, waitMs: Math.max(d.waitMs, 5000) });
  if (deps.logger && deps.logger.warn) deps.logger.warn('instance ' + inst.name + ' ' + reason + ', retry in ' + Math.max(d.waitMs, 5000) + 'ms');
  if (deps.save) deps.save();
}

module.exports = { setRunning, setStopped, fail, restart };
