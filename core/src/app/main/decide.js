'use strict';

const pidlook = require('../../platform/os/pidlookup');

function startDeadlinePassed(deadline, now) {
  return !!(deadline && now > deadline);
}

// 主链存活判据（W1 单源）：进程还在 ⇒ 活着。不是端口、不是 HTTP（R-06 已去健康门）。
// 三处曾各写一遍这段判定（decide.js / controller.js / state/upgrade-hold.js），逐字重复 ⇒ 任何一处改口径都会漂移。
// H-02 的实例域版本在 platform/service/monitor.js#probeInstance（受管实例：端口 + cmdline 身份），
// 与主链不是同一件事：主链持有 child 句柄 / adopt pid，不需要端口或 cmdline 反查。
// 参数刻意只取原始读数（child / adoptPid），不取 host ⇒ 三个调用方（decide / controller / upgrade-hold）都能用。
function childAlive(child) {
  return !!(child && child.exitCode === null && child.signalCode === null);
}
function adoptedAlive(adoptPid) {
  return adoptPid !== null && adoptPid !== undefined && pidlook.isAlive(adoptPid);
}
// 「目标进程是否活着」= 自 spawn 的 child 还活着 ∨ 接管的 pid 还活着。
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
      // 端口视角（不是存活判据）：只喂孤儿接管/占用分支。
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
  startDeadlinePassed, childAlive, adoptedAlive, targetAlive,
};
