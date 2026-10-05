'use strict';

const spawnOS = require('../../platform/os/spawn');
const pidlook = require('../../platform/os/pidlookup');
const { LineBuffer } = require('../../platform/service/log/log');
const native = require('../../app/native/command');
const BRAND = require('../../shared/brand');
const { findManagedDshPort, applyMainPort } = require('./port-rederive');

const DEPS = new WeakMap();
const HELPERS = ['MissingNotified', 'SetMissingNotified', 'SetSpawnBlockedUntil', 'SetChild',
  'Child', 'SetAdopted', 'SetAdoptPid', 'AdoptPid', 'SetObservedOnly', 'StartDeadline', 'SetStartDeadline',
  'SetStartupFailWindowStart', 'SetStartupFailCount', 'SetLastFailure', 'SetLastRestartAt',
  'SetRestartCount', 'RestartCount', 'SetRestartAt'];
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config: () => host.config, main: () => host.main, events: () => host.events,
      logger: () => host.logger, ui: () => host.ui, state: () => host.state,
      daemons: () => host.daemons, nativeManager: () => host.nativeManager,
      tokenService: () => host.tokenService, dshWriter: () => host.dshWriter,
      pluginManager: () => host.pluginManager, stopping: () => host._stopping,
      writeCrashHalted: (v) => { host._crashHalted = v; },
      spawnCommand: () => host.spawnCommand(),
      beginRestart: (reason, opts) => host._beginRestart(reason, opts),
      writeMainOwner: (pid, port) => host._writeMainOwner(pid, port),
    };
    for (const n of HELPERS) d['m' + n] = (...a) => host['_m' + n](...a);
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  spawnCommand() {
    const d = depsOf(this);
    return native.nativeCommand(d.config(), d.pluginManager());
  },

  // 启动窗口（毫秒）：唯一的时间常量，spawn 时落成 startDeadline，窗口内退出即「启动失败」。
  startWindowMs() {
    const d = depsOf(this);
    const secs = Number(d.config().startsecs);
    return Math.max(1, Math.round((Number.isFinite(secs) && secs > 0 ? secs : 10) * 1000));
  },

  async _startProcess() {
    const d = depsOf(this);
    d.writeCrashHalted(false);
    const nst = d.nativeManager() ? d.nativeManager().status() : { installed: true };
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
    d.mSetChild(child);
    d.mSetAdopted(false);
    d.mSetAdoptPid(null);
    // 计数不在此清零：窗口内连续失败要靠它累计（清零点只有「进入 RUNNING / 接管 / 人工重试 / 显式停止」）。
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
      // 已经判定重启（等端口释放落点），同一退出不重复记账；否则「杀一次记两次」。
      if (phase === 'STARTING' && d.mStartDeadline() === null) return;
      if (phase === 'RUNNING' || phase === 'STARTING') {
        const why = code !== null ? String(code) : 'sig' + signal;
        const inStartup = phase === 'STARTING';
        if (inStartup || d.state().guardian()) {
          d.beginRestart('exit:' + why, { startupFailure: inStartup });
        } else {
          d.writeCrashHalted(true);
          d.events().append('guardian_off_exit', { reason: 'child_exit:' + why + ' 未监控，保持停止' });
          d.state().setPhase('STOPPED');
        }
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
      // 启动成功：本次限流窗口作废（启动成功即清零，失败链只统计「从未起来」的那串）。
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
    d.state().setPhase('OBSERVED');
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
    d.state().write();
  },

  // 重启：活过 startsecs 后退出（或人工重启）⇒ 正常重启，不记启动失败；窗口内退出 ⇒ 记一次启动失败并由限流裁决。
  // 相位只有 STARTING / RUNNING / FAILED：重启=回到 STARTING（下一次 spawn 会开新的 startsecs 窗口）。
  _beginRestart(reason, opts) {
    const d = depsOf(this);
    const manual = !!(opts && opts.manual);
    const phase = d.state().phase();
    const startupFailure = (opts && opts.startupFailure !== undefined)
      ? opts.startupFailure === true
      : (!manual && phase === 'STARTING');
    d.mSetLastFailure(reason);
    d.mSetLastRestartAt(new Date().toISOString());
    d.events().append('restart_triggered', { reason, startupFailure, manual });
    d.logger().warn('restart triggered: ' + reason + (startupFailure ? '（启动窗口内退出，计一次启动失败）' : '（正常重启）'));
    d.tokenService().clear('main');
    if (!manual) d.mSetRestartCount(d.mRestartCount() + 1);
    const throttle = startupFailure ? d.main().noteStartupFailure() : null;
    if (throttle && throttle.failed) {
      // 限流到点：不排下一轮，停在 FAILED 等人工重试。
      d.mSetRestartAt(null);
    } else {
      d.state().setPhase('STARTING');
      d.mSetRestartAt(Date.now() + d.config().portReleaseWaitMs);
    }
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
    // 显式停止是人的意图：计数作废，下次 start 是干净的一条链。
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
  },
};
