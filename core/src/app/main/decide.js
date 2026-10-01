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
  }
  },
  startDeadlinePassed,
};
