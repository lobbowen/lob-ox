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
      mLastProbeOk() { return host._mLastProbeOk(); },
      mLastProbeHttpOk() { return host._mLastProbeHttpOk(); },
      mChild() { return host._mChild(); },
      mAdoptPid() { return host._mAdoptPid(); },
      mAdopted() { return host._mAdopted(); },
      mObservedOnly() { return host._mObservedOnly(); },
      mSpawnBlockedUntil() { return host._mSpawnBlockedUntil(); },
      mStartDeadline() { return host._mStartDeadline(); },
      mRestartAt() { return host._mRestartAt(); },
      mBackoffUntil() { return host._mBackoffUntil(); },
      mCrashWindowStart() { return host._mCrashWindowStart(); },
      mCrashWindowRestarts() { return host._mCrashWindowRestarts(); },
      mBackoffLevel() { return host._mBackoffLevel(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

function decideCrashRestart(reason) {
  return { action: 'restart', reason, countCrash: true };
}

module.exports = {
  methods: {
  _mainStateSnapshot() {
    const d = depsOf(this);
    const now = Date.now();
    return {
      phase: d.state().phase(),
      desired: d.state().desired(),
      probeOk: d.mLastProbeOk() === true,
      probeHttpOk: d.mLastProbeHttpOk() === true,
      childAlive: !!(d.mChild() && d.mChild().exitCode === null && d.mChild().signalCode === null),
      adoptedAlive: !!(d.mAdoptPid() !== null && pidlook.isAlive(d.mAdoptPid())),
      adoptedPidSet: d.mAdoptPid() !== null,
      childPresent: d.mChild() !== null,
      adopted: d.mAdopted() === true,
      observedOnly: d.mObservedOnly() === true,
      upgradeHold: d.upgradeHold() === true,
      manualRestart: d.manualRestart() === true,
      spawnBlocked: !!(d.mSpawnBlockedUntil() && now < d.mSpawnBlockedUntil()),
      startDeadlinePassed: startDeadlinePassed(d.mStartDeadline(), now),
      restartDue: d.mRestartAt() === null || now >= d.mRestartAt(),
      backoffDue: d.mBackoffUntil() === null || now >= d.mBackoffUntil(),
      crashHalted: d.crashHalted() === true,
      sessionHalting: d.session().halting() === true,
      crashWindowStart: d.mCrashWindowStart(),
      crashWindowRestarts: d.mCrashWindowRestarts(),
      backoffLevel: d.mBackoffLevel(),
    };
  },

  _decideMainAction(s) {
    if (!s) return { action: 'none', reason: 'no-snapshot' };
    const targetAlive = s.childAlive || s.adoptedAlive;
    if (s.desired === 'stopped') {
      const managedAlive = s.childAlive || (s.adoptedAlive && !s.observedOnly);
      if (managedAlive) return { action: 'stop', reason: 'desired_stopped' };
      if (s.adoptedAlive && s.observedOnly) return { action: 'none', reason: 'observe_steady' };
      if (s.probeOk) return { action: 'adoptObserved', reason: 'desired_stopped_observe' };
      return { action: 'none', reason: 'stopped_idle' };
    }
    if (s.upgradeHold) {
      if (targetAlive) return { action: 'stop', reason: 'upgrade_hold' };
      return { action: 'none', reason: 'upgrade_hold_wait' };
    }
    if (s.manualRestart) {
      if (s.phase === 'RUNNING' || s.phase === 'STARTING') return { action: 'restart', reason: 'manual', countCrash: false };
      if (s.phase === 'RESTARTING' || s.phase === 'BACKOFF') {
        if (!targetAlive) return { action: 'start', reason: 'manual_retry' };
      }
    }
    switch (s.phase) {
      case 'STOPPED': {
        if (s.sessionHalting) return { action: 'none', reason: 'session_halting' };
        if (s.crashHalted) return { action: 'none', reason: 'crash_halted_await_explicit_start' };
        if (s.probeOk) return { action: 'adopt', reason: 'adopt' };
        if (s.spawnBlocked) return { action: 'none', reason: 'command_missing_cooloff' };
        return { action: 'start', reason: 'spawn' };
      }
      case 'STARTING': {
        if (s.probeOk && s.probeHttpOk) return { action: 'enterRunning', reason: 'healthy' };
        if (s.startDeadlinePassed) return decideCrashRestart('start_timeout');
        return { action: 'none', reason: 'starting_wait' };
      }
      case 'RUNNING': {
        if (s.adoptedPidSet && !s.adoptedAlive) return decideCrashRestart('adopted_exit');
        if (s.childPresent && !s.childAlive) return decideCrashRestart('child_exit');
        return { action: 'none', reason: 'running_steady' };
      }
      case 'RESTARTING': {
        if (s.probeOk && s.probeHttpOk && !s.childAlive && !s.adoptedAlive) return { action: 'adopt', reason: 'restart_adopt' };
        if (!targetAlive && s.restartDue) return { action: 'start', reason: 'restart_spawn' };
        return { action: 'none', reason: 'restart_wait' };
      }
      case 'BACKOFF': {
        if (s.probeOk && s.probeHttpOk && !s.childAlive && !s.adoptedAlive) return { action: 'adopt', reason: 'backoff_adopt' };
        if (!targetAlive && s.backoffDue) return { action: 'start', reason: 'backoff_spawn' };
        return { action: 'none', reason: 'backoff_wait' };
      }
      case 'OBSERVED': return { action: 'none', reason: 'observed_steady' };
    }
    return { action: 'none', reason: 'unknown_phase:' + s.phase };
  },

  _decideCrashRestart(reason) {
    return decideCrashRestart(reason);
  }
  },
  startDeadlinePassed,
};
