'use strict';

const execPath = require('../../platform/os/exec-path');
const policies = require('../native/policies');
const BRAND = require('../../shared/brand');

const path = require('node:path');
const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
const { createShellWatchdog } = require('../../domains/shell/watchdog');
const pidlook = require('../../platform/os/pidlookup');
const platform = require('../../platform/os/index');

const ENV_FORM_STARTUP_DELAY_MS = 3000;

function _bootstrap(host) {
    try {
      host.events.append('guard_started', {
        pid: process.pid,
        version: host.guardVersion,
        healthUrl: host.config.healthUrl,
        api: host.config.apiHost + ':' + host.config.apiPort,
      });
    } catch {}
    try { host.lifecycle.markStarted(); } catch {}
    host.logger.info('guard started v' + host.guardVersion + ' pid=' + process.pid);
    host._startupFacts = {
      bootAt: Date.now(), envDelayMs: ENV_FORM_STARTUP_DELAY_MS,
      routerAutostart: host.config.routerAutostart === true,
      routerMode: null, updateCheck: null, shellWatchdog: null, lastRefresh: null,
    };
    host.tick();
    host._timer = host.managedObjects ? null : setInterval(() => host.tick(), host.config.tickIntervalMs);
    host._lastHeartbeatAt = Date.now();
    host._heartbeatStalls = 0;
        // 心跳代际：stall 兜底放行下一拍后旧拍迟到结算会清掉新拍标记。
    host._heartbeatBeat = host._heartbeatBeat || 0;
    const heartbeatIv = host.config.tickIntervalMs || 5000;
    host._heartbeatTimer = setInterval(() => {
      if (host._heartbeatBusy) return;
      host._heartbeatBusy = true;
      const iv = heartbeatIv;
      const beat = ++host._heartbeatBeat;
      host._lastHeartbeatAt = Date.now();
      const objCount = (host.managedObjects && typeof host.managedObjects.count === 'function')
        ? host.managedObjects.count() : 1;
      const stallMs = Math.max(30000, iv * 12, objCount * 6 * iv + iv);
      const guard = setTimeout(() => {
        if (host._heartbeatBusy && beat === host._heartbeatBeat) {
          host._heartbeatBusy = false;
          host._heartbeatStalls++;
          if (host.logger && host.logger.warn) {
            host.logger.warn('[heartbeat] 单拍超过 ' + stallMs + 'ms 未结算，强制释放防停摆（第 ' + host._heartbeatStalls + ' 次）');
          }
        }
      }, stallMs);
      if (guard && typeof guard.unref === 'function') guard.unref();
      Promise.resolve(host.managedObjects ? host.managedObjects.heartbeat(iv) : null)
        .catch(() => {})
        .finally(() => {
          clearTimeout(guard);
          if (beat === host._heartbeatBeat) host._heartbeatBusy = false;
        });
    }, heartbeatIv);
    if (host.lanDaemonEnabled()) {
      host._syncLanState();
      const lrt = host._ensureLanRuntime(true);
      if (host.logger && host.logger.info) host.logger.info('[lan] L3b 模式：lan-daemon ' + (lrt.mode === 'daemon' ? ('已就绪 pid=' + (lrt.spawned || '(既有)')) : ('未就绪 mode=' + lrt.mode)));
    } else {
      host.lan.reconcile().catch(() => {});
      host.lan.syncFrpc();
    }
    if (!host.managedObjects) host.instances.startTimer(host.config.tickIntervalMs || 5000);
    if (!host.lanDaemonEnabled()) {
      for (const inst of host.instances.all()) { if (inst.remoteMode === 'lan' || inst.remoteMode === 'wan') host.lan.syncProxy(inst).catch(() => {}); }
    }
    if (host.config.routerAutostart === true) {
      const rlc = host.lifecycleManager ? host.lifecycleManager.get('router') : null;
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc._setPhase && rlc._setPhase('starting'); }
      if (host._routerDaemonActive()) host._writeRouterDaemonLock();
      const rt = host._ensureRouterRuntime(true);
      host._startupFacts.routerMode = rt.mode;
      if (rt.mode === 'daemon') {
        host._disableRouterPersist();
        if (rt.spawned) {
          setTimeout(() => {
            const up = pidlook.findListeningPid(host._routerCtlPort());
            if (rlc) { if (up) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('starting'); }  }
          }, 3000);
        } else if (rt.active) {
          if (rlc) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); }
        }
      }
      if (rt.mode !== 'daemon') host.router.start().then((r) => {
        if (rlc) { if (r && r.ok !== false) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('stopped'); rlc.error = (r && r.error) || 'start 失败'; }  }
        if (r && r.ok === false) host.logger.warn('中转服务启动失败：' + (r.error || '未知错误'));
      });
    } else {
      const rlc = host.lifecycleManager ? host.lifecycleManager.get('router') : null;
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; }
    }
    const checkDelayMs = host.config.initialCheckDelayMs || 20000;
    const checkIntervalMs = host.config.updateCheckIntervalMs || 3600000;
    host._startupFacts.updateCheck = {
      enabled: host.config.updateCheckEnabled !== false,
      initialDelayMs: checkDelayMs, intervalMs: checkIntervalMs,
    };
    if (host.config.updateCheckEnabled !== false) {
      host._initialCheckTimer = setTimeout(() => {
        host.nativeManager.checkUpdate();
      }, checkDelayMs);
      host._upgradeTimer = setInterval(() => {
        host.nativeManager.checkUpdate();
      }, checkIntervalMs);
    }
    try {
      host._startShellWatchdog();
    } catch (e) {
      if (host.logger && host.logger.warn) {
        host.logger.warn('[shell-watchdog] 启动异常（不影响守卫主循环）: ' + ((e && e.message) || e));
      }
    }
    host._startupFacts.shellWatchdog = !!host.shellWatchdog;
    const envTimer = setTimeout(() => {
      try { host._refreshEnvironmentForm(); } catch (e) {
        host.logger.warn && host.logger.warn('[environment] 启动刷新异常（不影响守卫主循环）: ' + ((e && e.message) || e));
      }
    }, ENV_FORM_STARTUP_DELAY_MS);
    if (envTimer && envTimer.unref) envTimer.unref();
}

function _refreshEnvironmentForm(host) {
  const startedAt = Date.now();
  return platform.environment.refresh({ persist: true }).then((f) => {
    const secs = (f && f.sections) || {};
    const pending = Object.keys(secs).filter((id) => secs[id] && secs[id].state === 'pending');
    const failed = Object.keys(secs).filter((id) => secs[id] && secs[id].state === 'error');
    const snap = f && f.snapshot ? f.snapshot : {};
    if (host._startupFacts) {
      const states = {};
      for (const id of Object.keys(secs)) states[id] = secs[id] ? secs[id].state : 'missing';
      host._startupFacts.lastRefresh = {
        at: (f && f.at) || null, tookMs: Date.now() - startedAt, dims: states,
        browsers: (f && f.browsers && f.browsers.length) || 0,
        pick: (f && f.pick && f.pick.how) || null,
        snapshotWritten: snap.written === true,
      };
    }
    if (snap.written === false && snap.error) {
      host.logger.warn && host.logger.warn('[environment] 快照未落盘: ' + snap.error);
    }
    if (failed.length) {
      host.logger.warn && host.logger.warn('[environment] 维度探测失败: ' + failed.map((id) => id + '(' + secs[id].error + ')').join('; '));
    }
    if (pending.length) {
      host.logger.warn && host.logger.warn('[environment] 维度无探针，本机该项不可判: ' + pending.join(','));
    }
    host.logger.info && host.logger.info('[environment] 已刷新：' + Object.keys(secs).length + ' 个维度，浏览器候选 '
      + ((f && f.browsers && f.browsers.length) || 0) + ' 个，分发依据 ' + ((f && f.pick && f.pick.how) || '?'));
    return f;
  }).catch((e) => {
    host.logger.warn && host.logger.warn('[environment] 刷新失败（不影响守卫主循环）: ' + ((e && e.message) || e));
    return null;
  });
}

function _startShellWatchdog(host) {
    if (host.config.shellWatchdog === false) {
      host.logger.info && host.logger.info('[shell-watchdog] 已按配置禁用');
      return;
    }
    try {
      host.shellWatchdog = createShellWatchdog({
        shell: host.shellDomain,
        pidlookup: pidlook, desktop: platform.desktop,
        logger: host.logger,
        events: host.events,
        config: host.config,
        halted: () => host._shellExitIntended(),
        onShellAlive: () => {
          if (!host._shellHalted) return;
          if (host._stopping) return;
          if (host._sessionHalting && host._sessionHalting()) return;
          host._shellHalted = false;
          try { host.writeState(true); } catch {}
        },
      });
      host._shellWatchdogTimer = setInterval(() => {
        Promise.resolve(host.shellWatchdog.tick()).catch(() => {});
      }, host.shellWatchdog.intervalMs);
      if (host._shellWatchdogTimer.unref) host._shellWatchdogTimer.unref();
      host.logger.info && host.logger.info('[shell-watchdog] 已启用（周期 ' +
        Math.round(host.shellWatchdog.intervalMs / 1000) + 's）');
    } catch (e) {
      host.logger.warn && host.logger.warn('[shell-watchdog] 初始化失败（不影响守卫）: ' + ((e && e.message) || e));
    }
}

function _registerFixedPorts(host) {
    ports.register('dsh-main', host.config.targetPort);
    ports.registerSole('supervisor-api', host.config.apiPort);
}

function _bindNativeDshCommand(host) {
    try {
      const cmd = Array.isArray(host.config.command) ? host.config.command.slice() : [];
      const cur = cmd[1];
      // 判据取 native/policies.isBareCommand 的单源（W1）：此处曾内联抄一遍同样的四个条件 ⇒ 改判据必漏一处。
      const isBare = policies.isBareCommand(cur);
      if (!isBare) return;
      const d = execPath.resolveDsh();
      if (!d || !d.bin) return;
      host.config.command = d.isJs
        ? [d.runtime || process.execPath, d.bin, ...cmd.slice(2)]
        : [d.bin, ...cmd.slice(2)];
      try { host.events && host.events.append(BRAND.EVENT_HARNESS_COMMAND_BOUND, { from: cur || null, to: host.config.command[1] }); } catch {}
      try { host.logger.info && host.logger.info('原生 DSH 已绑定: ' + host.config.command.join(' ')); } catch {}
    } catch (e) { try { host.logger.warn && host.logger.warn('原生 DSH 绑定失败: ' + (e && e.message)); } catch {} }
}

module.exports = { _bootstrap, _startShellWatchdog, _registerFixedPorts, _bindNativeDshCommand, _refreshEnvironmentForm };
