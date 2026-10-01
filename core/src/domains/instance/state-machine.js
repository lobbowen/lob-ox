'use strict';

const guardian = require('../../shared/guardian');

function setRunning(deps, inst, st, now) {
  const state = inst.state;
  state.phase = 'RUNNING';
  state.lastError = null;
  if ((state.lastFailAt || 0) && now - state.lastFailAt > 5 * 60 * 1000) {
    if ((state.restartCount || 0) > 0 || (state.backoffLevel || 0) > 0) {
      state.restartCount = 0;
      state.backoffLevel = 0;
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
  if (deps.save) deps.save();
}

function fail(deps, inst, reason) {
  const state = inst.state;
  state.phase = 'FAILED';
  state.lastError = reason;
  if (deps.events) deps.events.append('inst_failed', { id: inst.id, name: inst.name, reason });
  if (deps.logger && deps.logger.error) deps.logger.error('instance ' + inst.name + ' FAILED: ' + reason);
  if (deps.save) deps.save();
}

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
  state.backoffUntil = now + Math.max(d.waitMs, 5000);
  if (deps.events) deps.events.append('inst_restarted', { id: inst.id, name: inst.name, reason, waitMs: Math.max(d.waitMs, 5000) });
  if (deps.logger && deps.logger.warn) deps.logger.warn('instance ' + inst.name + ' ' + reason + ', retry in ' + Math.max(d.waitMs, 5000) + 'ms');
  if (deps.save) deps.save();
}

module.exports = { setRunning, setStopped, fail, restart };
