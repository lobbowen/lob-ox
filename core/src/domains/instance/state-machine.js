'use strict';

const guardian = require('../../shared/guardian');

// 实例域（沙箱）重启策略：与主链共用同一条规则、同一份实现（U-5 统一重启策略）。
// 唯一一条规则：
//   启动窗口内起不来 ⇒ 记一次 startupFail（记账由 shared/guardian.bumpStartupFailure 裁决，本文件不复制判定）；
//   窗口内 startupFail 达 N 次 ⇒ phase='FAILED'，停止自动重启，只等人工重试（带 manual 的 start 清计数）；
//   活过启动窗口后退出 ⇒ 正常重启，不计失败、无上限。
// 已删除：backoffLevel / backoffUntil / 'BACKOFF' 相位 / 等级等待 / 阶梯。
// 域参数（窗口/次数）走 deps.throttle，按域参数化；算法本体只在 shared/guardian.js。
// 不变量：windowMs > burst × STARTUP_WINDOW_MS（600s > 5×30s）；同一规则按域参数化，主链见 platform/service/config.js。
const THROTTLE_DEFAULTS = { windowMs: 10 * 60 * 1000, burst: 5 };
// 实例域「启动窗口」：STARTING 起 30s 仍未监听端口 ⇒ 本次启动失败。
// probe 只回答「谁在监听这个端口」（platform/service/monitor.js），没有跨平台存活判据，
// 因此实例域的「窗口内起不来」以「窗口内没监听」为准，语义等同主链的「startsecs 窗口内退出」。
const STARTUP_WINDOW_MS = 30000;
// 固定端口释放等待（单值，等价主链 config.portReleaseWaitMs 的角色）：不是阶梯，
// 只是「上一次的单元/端口先凉下来再拉起」的等长间隔。
const RESTART_DELAY_MS = 5000;

function throttleCfg(deps) {
  const t = (deps && deps.throttle) || {};
  return {
    windowMs: Number(t.windowMs) > 0 ? Number(t.windowMs) : THROTTLE_DEFAULTS.windowMs,
    burst: Number(t.burst) >= 1 ? Number(t.burst) : THROTTLE_DEFAULTS.burst,
  };
}

// 显式停止 / 进入 RUNNING / 人工重试：本次失败链作废（同主链 _enterRunning、stopProcess、_retryStartupFailure 的清零语义）。
// 返回是否确有旧计数被清掉（供调用方决定是否记一笔 retry 事件）。
function clearStartupFailures(inst) {
  const state = inst.state;
  if (!state) return false;
  const had = (state.startupFailCount || 0) > 0 || state.startupFailWindowStart !== null || state.restartAt !== null;
  state.startupFailWindowStart = null;
  state.startupFailCount = 0;
  state.restartAt = null;
  return !!had;
}

function setRunning(deps, inst, st, now) {
  const state = inst.state;
  state.phase = 'RUNNING';
  state.lastError = null;
  // 起来了：启动失败链作废（只统计「从未起来」的那一串，同主链 _enterRunning）。
  clearStartupFailures(inst);
  // 稳定窗语义：距上次失败 >5 分钟视为已恢复稳定，清展示用计数，防偶发重启跨时间无限累计。
  if ((state.lastFailAt || 0) && now - state.lastFailAt > 5 * 60 * 1000) {
    if ((state.restartCount || 0) > 0) {
      state.restartCount = 0;
      state.lastFailAt = null;
    }
  }
  if (deps.events) deps.events.append('inst_running', { id: inst.id, name: inst.name, pid: st.pid });
  if (inst.domain === 'sandbox' && deps.tokens) {
    deps.tokens.attach(inst.id, { unit: 'dsh-web@' + inst.id });
    deps.tokens.scheduleCapture(inst.id);
  }
}

function setStopped(deps, inst) {
  const state = inst.state;
  state.phase = 'STOPPED';
  state.lastError = null;
  state.restartAt = null;
  clearStartupFailures(inst);
  if (deps.save) deps.save();
}

// 停靠：phase='FAILED' 后不再有任何自动重启路径（监督拍 FAILED 分支为空），
// 唯一出口是人工重试（面板 start → startInstance(id, { manual: true })）。
function fail(deps, inst, reason) {
  const state = inst.state;
  state.phase = 'FAILED';
  state.lastError = reason;
  state.restartAt = null;
  if (deps.events) deps.events.append('inst_failed', { id: inst.id, name: inst.name, reason });
  if (deps.logger && deps.logger.error) deps.logger.error('instance ' + inst.name + ' FAILED: ' + reason);
  if (deps.save) deps.save();
}

// 重启记账（唯一一处）：不自己写阈值判定，只调 shared/guardian.bumpStartupFailure。
// opts.startupFailure 缺省按「当前相位是否还没起来过」推导（STARTING/INSTALLING ⇒ 算启动失败）。
// 返回 { halted, startupFailure, count, restartAt }；halted=true 表示已 FAILED，调用方不得再拉起。
function restart(deps, inst, reason, opts) {
  const o = opts || {};
  const state = inst.state;
  const now = Date.now();
  const manual = o.manual === true;
  const startupFailure = (o.startupFailure !== undefined)
    ? o.startupFailure === true
    : (!manual && (state.phase === 'STARTING' || state.phase === 'INSTALLING'));
  const enterStartingWaiting = () => {
    state.phase = 'STARTING';
    state.startAt = null;
    state.restartAt = now + RESTART_DELAY_MS;
    state.lastError = null;
  };
  state.restartCount = (state.restartCount || 0) + 1;
  state.lastFailure = reason;
  if (!startupFailure) {
    // 活过启动窗口后退出（或资源违规处置）：正常重启，不计失败、无上限、无阶梯。
    enterStartingWaiting();
    if (deps.events) deps.events.append('inst_restarted', { id: inst.id, name: inst.name, reason, startupFailure: false, restartAt: state.restartAt });
    if (deps.logger && deps.logger.warn) deps.logger.warn('instance ' + inst.name + ' ' + reason + '（活过启动窗口：正常重启，不计启动失败）');
    if (deps.save) deps.save();
    return { halted: false, startupFailure: false, count: state.startupFailCount || 0, restartAt: state.restartAt };
  }
  const cfg = throttleCfg(deps);
  const dec = guardian.bumpStartupFailure(
    { start: state.startupFailWindowStart, count: state.startupFailCount },
    now,
    { windowMs: cfg.windowMs, burst: cfg.burst }
  );
  state.startupFailWindowStart = dec.start;
  state.startupFailCount = dec.count;
  state.lastFailAt = now;
  if (deps.events) {
    deps.events.append('inst_startup_fail', { id: inst.id, name: inst.name, reason, count: dec.count, burst: cfg.burst, windowMs: cfg.windowMs });
  }
  if (dec.tripped) {
    const why = '启动反复失败 ' + dec.count + ' 次（窗口 ' + Math.round(cfg.windowMs / 1000) + 's）：已停止自动重启，等人工重试';
    if (deps.events) deps.events.append('inst_startup_failed', { id: inst.id, name: inst.name, count: dec.count, windowMs: cfg.windowMs, retry: 'instances/start' });
    fail(deps, inst, why);
    return { halted: true, startupFailure: true, count: dec.count, restartAt: null };
  }
  enterStartingWaiting();
  if (deps.logger && deps.logger.warn) {
    deps.logger.warn('instance ' + inst.name + ' ' + reason + '（启动窗口内失败第 ' + dec.count + '/' + cfg.burst + ' 次，' + RESTART_DELAY_MS + 'ms 后立刻重试）');
  }
  if (deps.save) deps.save();
  return { halted: false, startupFailure: true, count: dec.count, restartAt: state.restartAt };
}

module.exports = {
  setRunning, setStopped, fail, restart, clearStartupFailures,
  THROTTLE_DEFAULTS, STARTUP_WINDOW_MS, RESTART_DELAY_MS,
};
