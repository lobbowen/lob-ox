'use strict';

const pidlook = require('../../platform/os/pidlookup');

function startDeadlinePassed(deadline, now) {
  return !!(deadline && now > deadline);
}

function childAlive(child) {
  return !!(child && child.exitCode === null && child.signalCode === null);
}
function adoptedAlive(adoptPid) {
  return adoptPid !== null && adoptPid !== undefined && pidlook.isAlive(adoptPid);
}

function targetAlive(child, adoptPid) {
  return childAlive(child) || adoptedAlive(adoptPid);
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
      
      portUp: d.portUp() === true,
      childAlive: childAlive(d.mChild()),
      adoptedAlive: adoptedAlive(d.mAdoptPid()),
      adoptedPidSet: d.mAdoptPid() !== null,
      childPresent: d.mChild() !== null,
      adopted: d.mAdopted() === true,
      observedOnly: d.mObservedOnly() === true,
      upgradeHold: d.upgradeHold() === true,
      manualRestart: d.manualRestart() === true,
      spawnBlocked: !!(d.mSpawnBlockedUntil() && now < d.mSpawnBlockedUntil()),
      startDeadlinePassed: startDeadlinePassed(startDeadline, now),
      
      restartInFlight: phase === 'STARTING' && startDeadline === null,
      restartDue: d.mRestartAt() === null || now >= d.mRestartAt(),
      crashHalted: d.crashHalted() === true,
      sessionHalting: d.session().halting() === true,
      startupFailWindowStart: d.mStartupFailWindowStart(),
      startupFailCount: d.mStartupFailCount(),
    };
  }
  },
  startDeadlinePassed, childAlive, adoptedAlive, targetAlive,
};
