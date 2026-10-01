'use strict';

const pidlook = require('../../platform/os/pidlookup');

function startDeadlinePassed(deadline, now) {
  return !!(deadline && now > deadline);
}

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      state() { return host.state; },
      session() { return host.session; },
      upgradeHold() { return host._upgradeHold; },
      manualRestart() { return host.manualRestart; },
      crashHalted() { return host._crashHalted; },
      portUp() { return host._lastPortUp === true; },
      mChild() { return host._mChild(); },
      mAdoptPid() { return host._mAdoptPid(); },
      mAdopted() { return host._mAdopted(); },
      mObservedOnly() { return host._mObservedOnly(); },
      mSpawnBlockedUntil() { return host._mSpawnBlockedUntil(); },
      mStartDeadline() { return host._mStartDeadline(); },
      mRestartAt() { return host._mRestartAt(); },
      mStartupFailWindowStart() { return host._mStartupFailWindowStart(); },
      mStartupFailCount() { return host._mStartupFailCount(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

function decideRestart(reason) {
  return { action: 'restart', reason, startupFailure: false };
}

module.exports = {
  methods: {
  _mainStateSnapshot() {
    const d = depsOf(this);
    const now = Date.now();
    const phase = d.state().phase();
    const startDeadline = d.mStartDeadline();
    return {
      phase,
      desired: d.state().desired(),
      // 端口视角（不是存活判据）：只喂孤儿接管/占用分支。
      portUp: d.portUp() === true,
      childAlive: !!(d.mChild() && d.mChild().exitCode === null && d.mChild().signalCode === null),
      adoptedAlive: !!(d.mAdoptPid() !== null && pidlook.isAlive(d.mAdoptPid())),
      adoptedPidSet: d.mAdoptPid() !== null,
      childPresent: d.mChild() !== null,
      adopted: d.mAdopted() === true,
      observedOnly: d.mObservedOnly() === true,
      upgradeHold: d.upgradeHold() === true,
      manualRestart: d.manualRestart() === true,
      spawnBlocked: !!(d.mSpawnBlockedUntil() && now < d.mSpawnBlockedUntil()),
      startDeadlinePassed: startDeadlinePassed(startDeadline, now),
      // STARTING 且没有存活进程/没记启动窗口 = 已判定重启，等端口释放落点。
      restartInFlight: phase === 'STARTING' && startDeadline === null,
      restartDue: d.mRestartAt() === null || now >= d.mRestartAt(),
      crashHalted: d.crashHalted() === true,
      sessionHalting: d.session().halting() === true,
      startupFailWindowStart: d.mStartupFailWindowStart(),
      startupFailCount: d.mStartupFailCount(),
    };
  },

  _decideMainAction(s) {
    if (!s) return { action: 'none', reason: 'no-snapshot' };
    const targetAlive = s.childAlive || s.adoptedAlive;
    if (s.desired === 'stopped') {
      const managedAlive = s.childAlive || (s.adoptedAlive && !s.observedOnly);
      if (managedAlive) return { action: 'stop', reason: 'desired_stopped' };
      if (s.adoptedAlive && s.observedOnly) return { action: 'none', reason: 'observe_steady' };
      if (s.portUp) return { action: 'adoptObserved', reason: 'desired_stopped_observe' };
      return { action: 'none', reason: 'stopped_idle' };
    }
    if (s.upgradeHold) {
      if (targetAlive) return { action: 'stop', reason: 'upgrade_hold' };
      return { action: 'none', reason: 'upgrade_hold_wait' };
    }
    if (s.manualRestart) {
      if (s.phase === 'RUNNING' || s.phase === 'STARTING') return { action: 'restart', reason: 'manual', manual: true };
      if (s.phase === 'FAILED') return { action: 'start', reason: 'startup_retry' };
      if (s.phase === 'STOPPED' && !targetAlive) return { action: 'start', reason: 'manual_retry' };
    }
    switch (s.phase) {
      case 'STOPPED': {
        if (s.sessionHalting) return { action: 'none', reason: 'session_halting' };
        if (s.crashHalted) return { action: 'none', reason: 'crash_halted_await_explicit_start' };
        if (s.portUp) return { action: 'adopt', reason: 'adopt' };
        if (s.spawnBlocked) return { action: 'none', reason: 'command_missing_cooloff' };
        return { action: 'start', reason: 'spawn' };
      }
      case 'STARTING': {
        // STARTING = startsecs 窗口内。窗口到点且进程活着 ⇒ RUNNING；进程死了 ⇒ 由事件记账后重新 spawn。
        if (!targetAlive) {
          if (s.restartDue) return { action: 'start', reason: 'restart_spawn' };
          return { action: 'none', reason: 'restart_wait_release' };
        }
        if (s.startDeadlinePassed) return { action: 'enterRunning', reason: 'startsecs_elapsed' };
        return { action: 'none', reason: 'starting_window' };
      }
      case 'RUNNING': {
        if (s.adoptedPidSet && !s.adoptedAlive) return decideRestart('adopted_exit');
        if (s.childPresent && !s.childAlive) return decideRestart('child_exit');
        return { action: 'none', reason: 'running_steady' };
      }
      case 'FAILED': {
        // 限流停靠：只有人工重试（manualRestart / 显式 start 意图）才回 STARTING。
        return { action: 'none', reason: 'startup_failed_halted' };
      }
      case 'OBSERVED': return { action: 'none', reason: 'observed_steady' };
    }
    return { action: 'none', reason: 'unknown_phase:' + s.phase };
  },

  _decideRestart(reason) {
    return decideRestart(reason);
  }
  },
  startDeadlinePassed,
};
