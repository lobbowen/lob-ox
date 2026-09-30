'use strict';

// app/main/decide.js —— 主进程收敛的纯决策段（_mainStateSnapshot/_decideMainAction/_decideCrashRestart）。
// 导出 { methods }，由 app/assembly/facets.js 装到 host；方法名与 { methods } 形态不可改。
// _decideMainAction 必须零 this：shadow-decision-test 以 decide(base()) 形式裸调（this=undefined），
// 故其内部经模块内纯函数 decideCrashRestart() 协作、绝不触碰 deps；其余事实经 depsOf(host) 惰性缓存取得。
const pidlook = require('../../platform/os/pidlookup');

// STARTING 超时唯一判据：deadline 缺失（守卫从盘恢复、本字段不持久化）视为「未到期」，
// 由 controller 首拍重derive宽限——真实 tick 与影子共用本函数，禁止第二份写法。
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
      // 字段 helper 与状态读取经 host 既有安装转发。
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

/** 崩溃类 restart 决策（模块内纯函数）：语义与 _beginRestart(countCrash=true) 一致。
 *  刻意留作模块局部：_decideMainAction 允许无 host 裸调用，不能经 deps。 */
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
      // `_shouldRun()` 有两个否决位，快照必须建模（crashHalted/sessionHalting），否则影子每拍
      // 算出的应然与真实 tick 不一致，零 diff 门槛永久不可达。
      crashHalted: d.crashHalted() === true, // guardian=false 崩溃后停靠：等显式启动
      sessionHalting: d.session().halting() === true, // 退出流程中：抑制一切自动拉起
      crashWindowStart: d.mCrashWindowStart(),
      crashWindowRestarts: d.mCrashWindowRestarts(),
      backoffLevel: d.mBackoffLevel(),
    };
  },

  /** 纯决策：按现有 tick 语义计算「应然下一步」。action 词表：
   *  none/start/stop/adopt/adoptObserved/enterRunning/restart/backoff。
   *  只读快照，零副作用（影子与收敛复用同一决策源）。 */
  _decideMainAction(s) {
    if (!s) return { action: 'none', reason: 'no-snapshot' };
    const targetAlive = s.childAlive || s.adoptedAlive;
    // desired=stopped（正交于守护开关；显式用户意图永远生效）
    if (s.desired === 'stopped') {
      const managedAlive = s.childAlive || (s.adoptedAlive && !s.observedOnly);
      if (managedAlive) return { action: 'stop', reason: 'desired_stopped' };
      if (s.adoptedAlive && s.observedOnly) return { action: 'none', reason: 'observe_steady' };
      if (s.probeOk) return { action: 'adoptObserved', reason: 'desired_stopped_observe' };
      return { action: 'none', reason: 'stopped_idle' };
    }
    // 升级 hold：安装期间不拉起（超时自愈是业务钩子）
    if (s.upgradeHold) {
      if (targetAlive) return { action: 'stop', reason: 'upgrade_hold' };
      return { action: 'none', reason: 'upgrade_hold_wait' };
    }
    // 手动重启请求（守卫业务标志，本拍消费）
    if (s.manualRestart) {
      if (s.phase === 'RUNNING' || s.phase === 'STARTING') return { action: 'restart', reason: 'manual', countCrash: false };
      if (s.phase === 'RESTARTING' || s.phase === 'BACKOFF') {
        // tick 语义：先清 backoff/restartAt 再立即拉起（!targetAlive）
        if (!targetAlive) return { action: 'start', reason: 'manual_retry' };
        // targetAlive 则落 switch（端口占用检查统一生效）
      }
      // phase===STOPPED 则落 switch
    }
    switch (s.phase) {
      case 'STOPPED': {
        // 顺序与 `_shouldRun()` 一致：两个否决位必须先于拉起判断，否则影子会算出 start
        // 而真实 tick 拒绝，永久 diff。
        if (s.sessionHalting) return { action: 'none', reason: 'session_halting' };
        if (s.crashHalted) return { action: 'none', reason: 'crash_halted_await_explicit_start' };
        if (s.probeOk) return { action: 'adopt', reason: 'adopt' };
        if (s.spawnBlocked) return { action: 'none', reason: 'command_missing_cooloff' };
        return { action: 'start', reason: 'spawn' }; // 端口占用复查在执行期（isPortListening）
      }
      case 'STARTING': {
        if (s.probeOk && s.probeHttpOk) return { action: 'enterRunning', reason: 'healthy' };
        if (s.startDeadlinePassed) return decideCrashRestart('start_timeout');
        return { action: 'none', reason: 'starting_wait' };
      }
      case 'RUNNING': {
        // adopt 令牌重建/假死识别属守卫业务钩子（由 _dshConverge 承担），纯决策段不含。
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

  /** 崩溃类 restart 决策：与 _beginRestart(countCrash=true) 语义一致——动作统一 restart
   *  （_beginRestart 内部 _bumpCrashWindow 的退避记账/crash_loop_entered 属守卫业务，不改变动作词）。 */
  _decideCrashRestart(reason) {
    return decideCrashRestart(reason);
  }
  },
  // 非 host 方法：纯谓词导出，controller 与本文件快照判据共用（facets 只安装 methods）。
  startDeadlinePassed,
};
