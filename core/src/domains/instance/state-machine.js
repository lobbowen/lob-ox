'use strict';

const guardian = require('../../shared/guardian');

const THROTTLE_DEFAULTS = { windowMs: 10 * 60 * 1000, burst: 5 };

const STARTUP_WINDOW_MS = 30000;

const RESTART_DELAY_MS = 5000;

function throttleCfg(deps) {
  const t = (deps && deps.throttle) || {};
  return {
    windowMs: Number(t.windowMs) > 0 ? Number(t.windowMs) : THROTTLE_DEFAULTS.windowMs,
    burst: Number(t.burst) >= 1 ? Number(t.burst) : THROTTLE_DEFAULTS.burst,
  };
}

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
  
  clearStartupFailures(inst);
  
  if ((state.lastFailAt || 0) && now - state.lastFailAt > 5 * 60 * 1000) {
    if ((state.restartCount || 0) > 0) {
      state.restartCount = 0;
      state.lastFailAt = null;
    }
  }
  if (deps.events) deps.events.append('inst_running', { id: inst.id, name: inst.name, pid: st.pid });
  // 形态判据用 agent 域的 kind，不用 instance 自建的 domain（同值同生的重复字段）。
  if (inst.kind === 'sandbox' && deps.tokens) {
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

function fail(deps, inst, reason) {
  const state = inst.state;
  state.phase = 'FAILED';
  state.lastError = reason;
  state.restartAt = null;
  if (deps.events) deps.events.append('inst_failed', { id: inst.id, name: inst.name, reason });
  if (deps.logger && deps.logger.error) deps.logger.error('instance ' + inst.name + ' FAILED: ' + reason);
  if (deps.save) deps.save();
}

function restart(deps, inst, reason, opts) {
  const o = opts || {};
  const state = inst.state;
  const now = Date.now();
  const manual = o.manual === true;
  // ⚠️ 全仓共四处 startupFailure 判据（同名不同源，别对齐）：
  //   ① instance/state-machine.js（本处）  相位判 + THROTTLE_DEFAULTS 10min/5 次 → 沙箱重启策略
  //   ② instance/lifecycle.js             startAt 时间差 + STARTUP_WINDOW_MS 30s → 壳 last_will 上报
  //   ③ app/main/process.js               相位判 + config.startupFailWindowMs(60s) → 主 DSH 重启策略
  //   ④ router/providers/restart.js       started/wasRunning 判 + b.note() 限流器 → 反代实例
  // ① 与 ③ 判据同构、共享 guardian.bumpStartupFailure 原语，只差窗口参数（10min vs 60s）——
  //    那是唯一一对「改一处会漏改另一处」的，动任一处必须同时看另一处。
  // ② 不汇入节流只上报；④ 判据形状不同但经 makeBudget.note() 也汇到同一原语。
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
