'use strict';

const spawnOS = require('../../platform/os/spawn');
const pidlook = require('../../platform/os/pidlookup');
const { LineBuffer } = require('../../platform/service/log/log');
const native = require('../../platform/contract/native-command');
const BRAND = require('../../shared/brand');
const guardian = require('../../shared/guardian');
const pmClient = require('../../platform/contract/pm-client');
const { findManagedDshPort, applyMainPort } = require('./port-rederive');

const DEPS = new WeakMap();
const HELPERS = [
  'MissingNotified',
  'SetMissingNotified',
  'SetSpawnBlockedUntil',
  'SetChild',
  'Child',
  'SetAdopted',
  'SetAdoptPid',
  'AdoptPid',
  'SetObservedOnly',
  'StartDeadline',
  'SetStartDeadline',
  'StartupFailWindowStart',
  'SetStartupFailWindowStart',
  'StartupFailCount',
  'SetStartupFailCount',
  'SetLastFailure',
  'SetLastRestartAt',
  'SetRestartCount',
  'RestartCount',
  'SetRestartAt',
];

function assertHelpersBound(host) {
  const unresolved = HELPERS.filter((n) => typeof host['_m' + n] !== 'function');
  if (unresolved.length) {
    throw new Error('app/main/process: HELPERS 指向不存在的方法: ' + unresolved.map((n) => '_m' + n).join(', '));
  }
}

function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config: () => host.config, main: () => host.main, events: () => host.events,
      logger: () => host.logger, ui: () => host.ui, state: () => host.state,
      daemons: () => host.daemons, nativeAgent: () => host.nativeAgent,
      tokenService: () => host.tokenService, dshWriter: () => host.dshWriter,
      pluginManager: () => host.pluginManager, stopping: () => host._stopping,
      writeCrashHalted: (v) => { host._crashHalted = v; },
      spawnCommand: () => host.spawnCommand(),
      beginRestart: (reason, opts) => host._beginRestart(reason, opts),
      writeMainOwner: (pid, port) => host._writeMainOwner(pid, port),
    };
    // HELPERS 与 installFieldHelpers（state/field-tables.js）是两套独立的命名来源，
    // 靠字符串拼接对齐。任何一侧漏改，都只会在首次调用时 TypeError。
    // 装配期已由 assertHelpersBound 兜底（app/assembly/facets.js 调用）；
    // 这里保留同一条判据，覆盖「未走装配路径直接构造 deps」的调用形态。
    assertHelpersBound(host);
    for (const n of HELPERS) d['m' + n] = (...a) => host['_m' + n](...a);
    DEPS.set(host, d);
  }
  return d;
}

const methods = {
  spawnCommand() {
    const d = depsOf(this);
    return native.nativeCommand(d.config(), d.pluginManager());
  },

  
  startWindowMs() {
    const d = depsOf(this);
    const secs = Number(d.config().startsecs);
    return Math.max(1, Math.round((Number.isFinite(secs) && secs > 0 ? secs : 10) * 1000));
  },

  async _startProcess() {
    const d = depsOf(this);
    d.writeCrashHalted(false);
    const nst = d.nativeAgent() ? d.nativeAgent().status() : { installed: true };
    if (!nst.installed) {
      d.events().append(BRAND.EVENT_HARNESS_NOT_INSTALLED, { bin: nst.binPath });
      if (!d.mMissingNotified()) {
        d.mSetMissingNotified(true);
        d.ui().notify('未检测到 DeepSeek Harness', '可在 lobox 面板一键安装');
      }
      d.mSetSpawnBlockedUntil(Date.now() + 60000);
      d.state().setPhase('STOPPED');
      d.state().write();
      return;
    }
    d.events().append('spawn', { command: d.spawnCommand() });
    const [cmd, ...args] = d.spawnCommand();
    let child;
    try {
      child = spawnOS.piped(cmd, args, { env: process.env, detached: true });
    } catch (err) {
      d.events().append('spawn_failed', { message: err.message });
      d.logger().error('spawn failed: ' + err.message);
      d.beginRestart('spawn_error', { startupFailure: true });
      return;
    }
    d.logger().info('spawn pid=' + child.pid + ' cmd=' + d.spawnCommand().join(' '));
    // 壳退即全杀：请壳把这个 DSH 进程 assign 进它的 job。
    // 壳不在时静默跳过（pm-client.endpoint() 的同一个判定），不阻断启动主路径。
    //
    // id 用 'dsh-main' 而**不是** 'core'：壳进程表里 `core` 那一行代表的是**内核进程**
    // （`register_core` 的 `core_desc().id` = "core"，Priority::Core），而这里报的是
    // **DSH 主实例**的 pid。两个不同的东西共用一个 id ⇒ 后写的覆盖前写的
    // （§7.91：给字段加第二个写入方前，先核那个字段代表什么）。
    // 层 0 之后壳侧会建 `dsh-main` 行；在那之前壳不认这个 id 会忽略 + 记 info，
    // 与现状（DSH 的 pid 从未进过进程表）无差异 ⇒ 无回归。
    if (child.pid) { try { pmClient.keepAlive(child.pid, 'dsh-main'); } catch {  } }
    d.mSetChild(child);
    d.mSetAdopted(false);
    d.mSetAdoptPid(null);
    
    d.state().setPhase('STARTING');
    d.mSetStartDeadline(Date.now() + d.main().startWindowMs());
    const sanitizeToken = (l) => String(l).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***');
    const outBuf = new LineBuffer((line) => {
      d.tokenService().feedLine('main', line);

      const clean = sanitizeToken(line);
      d.dshWriter().write(clean);
      process.stdout.write('[dsh] ' + clean + '\n');
    });
    const errBuf = new LineBuffer((line) => {
      const clean = sanitizeToken('[stderr] ' + line);
      d.dshWriter().write(clean);
      process.stderr.write(clean + '\n');
    });
    child.stdout.on('data', (dd) => { outBuf.push(dd); });
    child.stderr.on('data', (dd) => { errBuf.push(dd); });
    child.on('error', (err) => {
      d.events().append('spawn_error', { message: err.message });
      if (d.mChild() === child && d.state().phase() === 'STARTING') {
        d.mSetChild(null);
        if (err.code === 'ENOENT') {
          d.events().append(BRAND.EVENT_HARNESS_COMMAND_MISSING, { command: d.config().command[0] });
          d.logger().warn('command missing: ' + d.config().command.join(' ') + ' — 60s 冷静期内不再尝试');
          if (!d.mMissingNotified()) {
            d.mSetMissingNotified(true);
            d.ui().notify('未检测到 DeepSeek Harness', '可在 lobox 面板一键安装');
          }
          d.mSetSpawnBlockedUntil(Date.now() + 60000);
          d.state().setPhase('STOPPED');
          d.state().write();
          return;
        }
        d.beginRestart('spawn_error:' + (err.code || 'unknown'), { startupFailure: true });
      }
    });
    child.on('exit', (code, signal) => {
      outBuf.flush();
      errBuf.flush();
      if (d.mChild() !== child) return;
      d.events().append(BRAND.EVENT_HARNESS_EXITED, { code, signal, phase: d.state().phase() });
      
      d.mSetChild(null);
      if (d.stopping()) return;
      if (d.state().desired() !== 'running') return;
      const phase = d.state().phase();
      
      if (phase === 'STARTING' && d.mStartDeadline() === null) return;
      if (phase === 'RUNNING' || phase === 'STARTING') {
        const why = code !== null ? String(code) : 'sig' + signal;
        const inStartup = phase === 'STARTING';
        // 进程退出只做相位投影与崩溃记录。是否重拉由壳的进程表决定
        //（heal_candidates：desired=running 且 phase=failed）。
        // 内核此前在这里另立一套 guardian 判据（d.state().guardian()），
        // 与壳的 desired 是同一语义的两种表达——用户在主面板关掉监控时
        // 只有内核知道，壳仍按 desired=running 重拉，两套进程管理互相打断。
        // 现已改为：内核 setDesired 时同步上报壳（app/state/desired.js），
        // 壳持有唯一判据。
        d.beginRestart('exit:' + why, { startupFailure: inStartup });
      }
    });
    d.events().append('spawned', { pid: child.pid });
    d.writeMainOwner(child.pid, d.config().targetPort);
    d.state().write();
  },

  _enterRunning() {
    const d = depsOf(this);
    const wasRunning = d.state().phase() === 'RUNNING';
    d.state().setPhase('RUNNING');
    d.mSetAdopted(false);
    if (!wasRunning) {
      
      d.mSetStartupFailWindowStart(null);
      d.mSetStartupFailCount(0);
      const pid = d.mChild() ? d.mChild().pid : null;
      d.events().append('running', { pid });
      d.logger().info('RUNNING pid=' + pid);
      d.tokenService().scheduleCapture('main');
    }
    d.state().write();
  },

  _adoptObserved() {
    const d = depsOf(this);
    d.state().setObservedOnly(true);
    d.state().setPhase('STOPPED');
    d.mSetAdopted(true);
    d.mSetObservedOnly(true);
    d.mSetChild(null);
    d.mSetAdoptPid(pidlook.findListeningPid(d.config().targetPort));
    if (d.mAdoptPid() === null) {
      const found = findManagedDshPort(d.config());
      if (found && found.port && found.port !== d.config().targetPort && applyMainPort(this, found.port, found.pid)) {
        d.config().targetPort = found.port;
        d.mSetAdoptPid(found.pid);
      }
    }
    d.events().append('adopted_observed', { pid: d.mAdoptPid() });
    d.logger().info('observed unmanaged instance pid=' + d.mAdoptPid() + ' (desired=stopped)');
    d.state().write();
  },

  _adopt() {
    const d = depsOf(this);
    d.state().setPhase('RUNNING');
    d.mSetAdopted(true);
    d.mSetObservedOnly(false);
    d.mSetChild(null);
    d.mSetStartupFailWindowStart(null);
    d.mSetStartupFailCount(0);
    d.mSetAdoptPid(pidlook.findListeningPid(d.config().targetPort));
    if (d.mAdoptPid() === null) {
      const found = findManagedDshPort(d.config());
      if (found && found.port && found.port !== d.config().targetPort) {
        if (applyMainPort(this, found.port, found.pid)) {
          d.config().targetPort = found.port;
          d.mSetAdoptPid(found.pid);
        }
      }
    }
    if (d.mAdoptPid() === null || !d.main().isManagedProcess(d.mAdoptPid())) {
      d.mSetAdoptPid(null);
      d.state().setPhase('STOPPED');
      d.daemons().warnOccupied();
      d.state().write();
      return;
    }
    d.events().append('adopted', { pid: d.mAdoptPid() });
    d.logger().info('adopted existing instance pid=' + d.mAdoptPid());
    d.writeMainOwner(d.mAdoptPid(), d.config().targetPort);
    d.tokenService().scheduleCapture('main');
    // 「接管」的第四条动作（排在 keepAlive 之前）：让壳的进程表有 'dsh-main' 那一行。
    //
    // 为什么必须有：壳的 heal_candidates 读进程表的行（mod.rs:185-193 的 spawn_cmd），
    // 而 keepAlive 只 assign job + 更新**已有**行的 pid ⇒ 没有这一行 ⇒ 壳永远不能主动
    // 管 DSH（不能 heal、不能停、/pm/status 里看不到它）。真机实证：dsh_main_row_missing。
    //
    // 为什么 spawn_cmd 用 spawnCommand()（2026-10-20 用户裁）：用户裁「换接管形态：
    // 让内核 spawn DSH」+「接受本产品接管 DSH 启动权」⇒ 所以用户自启的那个该停掉，
    // 而内核 spawn 的正是 spawnCommand() 那个命令 ⇒ 「A 会换掉用户启动方式」这个代价
    // 消失了（那时不做 A 的理由已不成立）。
    //
    // 为什么带 pid：architect 裁的 W-2-1「用声明代替测量」——壳不自己探 pid（那会造
    // 第二套发现），由内核在 register 时一并声明。壳侧 mgmt.rs:335-343 收到 pid 会
    // update_pid + 记 mgmt.registered_with_pid；而身份不一致会拒 + 409（dsh_main_pid_conflict）。
    //
    // 为什么不阻断：壳不在 ⇒ endpoint() 返 null ⇒ 返 false ⇒ 只是进程表没那一行，
    // 而认领本身已完成 ⇒ 降级不是失败（与 keepAlive 同一条）。
    try {
      const pid = d.mAdoptPid();
      const cmd = d.spawnCommand();
      const registered = pmClient.register({
        id: 'dsh-main',
        spawn_cmd: Array.isArray(cmd) ? cmd : [],
        priority: 'dsh-main',
        pid,
      });
      d.events().append(registered ? 'dsh_main_registered' : 'dsh_main_not_registered', {
        pid,
        spawnCmd: Array.isArray(cmd) ? cmd.length : 0,
        reason: registered ? null : (pmClient.endpoint() ? 'post_returned_false' : 'shell_absent'),
      });
    } catch (e) {
      try {
        d.events().append('dsh_main_register_failed', {
          pid: d.mAdoptPid(), error: (e && e.message) || String(e),
        });
      } catch {}
    }
    // 「接管」的第五条动作：把认领来的 DSH 上报给壳，请壳把它纳入「壳退即全杀」的 job。
    //
    // 为什么必须有（S-7b）：壳侧 job（bounded.rs 的 bind_kill_on_close）只 assign 壳自己
    // spawn 的那一个进程句柄，不覆盖进程树；而认领来的 DSH 壳从未 spawn 过 ⇒ 它不在
    // job 内 ⇒ 壳退时它不停。真机实证：本机 7580 是用户自启的 DSH（_adopt 认领来），
    // 壳退后它仍活着。
    //
    // 而用户裁「全面接管」：「当我们检测到在我们之前系统内存在 dsh 的时候，我们就应该
    // 给它全面做接管。接管后他应该按照我们的约束管理，而不是再遵循他原有的管理逻辑。」
    // ⇒ 认领（:250）+ 归属（:252）+ 上报壳（本处）三件合起来才是完整的接管。
    //
    // 为什么不阻断：壳不在 ⇒ endpoint() 返 null ⇒ 返 false ⇒ 只是不进 job，
    // 而认领本身已完成（内核仍能停它、能抓令牌）⇒ 那是降级不是失败。
    //
    // 语义窄一格（§7.96）：pm-client 的 post() 是 fire-and-forget（return true 只代表
    // 「请求已发出」）⇒ 所以 dsh_pid_reported 证明的是「内核把 pid 报出去了」，
    // **不是**「壳的 job 已覆盖它」。后者要核壳侧 mgmt.dsh_main_adopted。
    try {
      const pid = d.mAdoptPid();
      if (pmClient.keepAlive(pid, 'dsh-main')) {
        d.events().append('dsh_pid_reported', { pid, semantics: 'request_sent' });
      } else {
        const ep = pmClient.endpoint();
        d.events().append('dsh_pid_not_reported', {
          pid,
          reason: ep ? 'post_returned_false' : 'shell_absent',
        });
      }
    } catch (e) {
      try {
        d.events().append('dsh_pid_report_failed', {
          pid: d.mAdoptPid(), error: (e && e.message) || String(e),
        });
      } catch {}
    }
    d.state().write();
  },

  
  
  _beginRestart(reason, opts) {
    const d = depsOf(this);
    const manual = !!(opts && opts.manual);
    const phase = d.state().phase();
    // ⚠️ 全仓共四处 startupFailure 判据（同名不同源，别对齐）：
    //   ① instance/state-machine.js        相位判 + THROTTLE_DEFAULTS 10min/5 次 → 沙箱重启策略
    //   ② instance/lifecycle.js            startAt 时间差 + STARTUP_WINDOW_MS 30s → 壳 last_will 上报
    //   ③ app/main/process.js（本处）      相位判 + config.startupFailWindowMs(60s) → 主 DSH 重启策略
    //   ④ router/providers/restart.js      started/wasRunning 判 + b.note() 限流器 → 反代实例
    // 本处（③）与 ① 判据同构、共享 guardian.bumpStartupFailure 原语，只差窗口参数
    // （60s vs 10min）与对象（主 DSH vs 沙箱）——那是唯一一对「改一处会漏改另一处」的，
    // 动任一处必须同时看另一处。本处判的是壳拉起的内核对象（spawn 持有 child 句柄）。
    const startupFailure = (opts && opts.startupFailure !== undefined)
      ? opts.startupFailure === true
      : (!manual && phase === 'STARTING');
    d.mSetLastFailure(reason);
    d.mSetLastRestartAt(new Date().toISOString());
    d.events().append('restart_triggered', { reason, startupFailure, manual });
    d.logger().warn('restart triggered: ' + reason + (startupFailure ? '（启动窗口内退出，计一次启动失败）' : '（正常重启）'));
    d.tokenService().clear('main');
    if (!manual) d.mSetRestartCount(d.mRestartCount() + 1);
    let throttle = null;
    if (startupFailure) {
      throttle = guardian.bumpStartupFailure(
        { start: d.mStartupFailWindowStart(), count: d.mStartupFailCount() },
        Date.now(),
        {
          windowMs: d.config().startupFailWindowMs || 60000,
          burst: d.config().startupFailBurst || 5,
        },
      );
      d.mSetStartupFailWindowStart(throttle.start);
      d.mSetStartupFailCount(throttle.count);
    }
    if (throttle && throttle.tripped) {
      d.state().setPhase('FAILED');
      d.mSetStartDeadline(null);
      d.mSetRestartAt(null);
      d.writeCrashHalted(true);
      d.events().append('main_startup_failed', { reason, count: throttle.count });
      d.logger().error('主进程启动反复失败（' + throttle.count + ' 次），已停止自动重启');
      d.state().write();
      return;
    }
    d.state().setPhase('STARTING');
    d.mSetRestartAt(Date.now() + d.config().portReleaseWaitMs);
    d.mSetStartDeadline(null);
    const child = d.mChild();
    if (child && child.exitCode === null) d.main().killSequence(child);
    if (d.mAdoptPid() && pidlook.isAlive(d.mAdoptPid())) {
      try { d.main().killAdopted(d.mAdoptPid()); } catch (e) { d.logger().warn('adopt kill during restart: ' + e.message); }
    }
    d.state().write();
  },

  stopProcess(reason) {
    const d = depsOf(this);
    d.events().append('stop', { reason });
    d.logger().info('stop: ' + reason);
    const child = d.mChild();
    const adoptedPid = d.mAdoptPid();
    d.state().setPhase('STOPPED');
    d.mSetChild(null);
    d.mSetAdopted(false);
    d.mSetAdoptPid(null);
    
    d.mSetStartupFailWindowStart(null);
    d.mSetStartupFailCount(0);
    try {
      if (child && child.exitCode === null) d.main().killSequence(child);
      else if (adoptedPid) d.main().killAdopted(adoptedPid);
    } catch (e) {
      d.events().append('stop_failed', {
        reason,
        pid: adoptedPid || (child && child.pid) || null,
        error: (e && e.message) || String(e),
      });
      if (d.logger() && d.logger().warn) d.logger().warn('[main] stop 派遣失败: ' + ((e && e.message) || e));
    }
    d.state().write();
  }
};

module.exports = { methods, assertHelpersBound, HELPERS };
