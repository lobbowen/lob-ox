
'use strict';

const execPath = require('../../platform/os/exec-path');
const policies = require('../native/policies');
const BRAND = require('../../shared/brand');

const path = require('node:path');
const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
const pidlook = require('../../platform/os/pidlookup');
const { BeatScheduler } = require('../control/synchrony');
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
      routerMode: null, updateCheck: null, lastRefresh: null,
    };
    host._startupFacts.bootAt = Date.now();
    host._startupFacts.updateCheck = host._startupFacts.updateCheck || null;
    // T0/S6：单一节拍调度器取代散落的 setInterval/setTimeout 时钟。
    // 所有周期工作（主链收敛 / 心跳 / 壳看门狗 / 实例监督 / 升级巡检 / 环境刷新）
    // 都登记到 host._beatScheduler，由它统一推进；心跳的防停摆语义在 BeatScheduler 内保留。
    if (!host._beatScheduler) host._beatScheduler = new BeatScheduler({ logger: host.logger, intervalMs: host.config.tickIntervalMs || 5000 });
    const beat = host._beatScheduler;
    const tickMs = host.config.tickIntervalMs || 5000;
    beat.unregister('main'); beat.unregister('heartbeat'); beat.unregister('shell-watchdog'); beat.unregister('instance-supervise'); beat.unregister('upgrade-check');
    // 主链收敛（受 controller.converge 内部 _ticking 互斥保护）。
    beat.register('main', () => host.tick(), { every: 1 });
    // 心跳：ManagedRegistry 驱动 dsh/router-daemon/lan-daemon/sandbox-instance 适配器；
    // 失活（managedObjects 未初始化）时退化为主链自行收敛（与既有 fallback 等价）。
    beat.register('heartbeat', () => {
      if (host.managedObjects) return host.managedObjects.heartbeat(tickMs);
      return host.tick();
    }, { every: 1, timeoutMs: Math.max(30000, tickMs * 12) });
    // 实例域监督 + governSweep（原 instances.startTimer 独立 interval）。
    beat.register('instance-supervise', async () => {
      if (!host.instances) return;
      try { for (const inst of host.instances.all()) { if (inst.domain === 'native') continue; host.instances.supervise && host.instances.supervise(inst.id); } } catch (e) {}
      try { host.instances.governSweep && host.instances.governSweep(); } catch (e) {}
    }, { every: 1 });
    // 升级巡检：首跳延迟后按 checkIntervalMs 周期（原 _initialCheckTimer + _upgradeTimer 两个定时器）。
    if (host.config.updateCheckEnabled !== false) {
      const checkDelayMs = host.config.initialCheckDelayMs || 20000;
      const checkIntervalMs = Math.max(1, Math.round((host.config.updateCheckIntervalMs || 3600000) / tickMs));
      beat.register('upgrade-check', () => { try { host.nativeManager.checkUpdate(); } catch (e) {} }, { every: checkIntervalMs, firstDelayMs: checkDelayMs });
    }
    // 首拍立即跑一次（原 host.tick() 即时首拍语义）。
    beat.tick();
    beat.start(tickMs);
    // 兼容引用：保留字段名，指向统一调度器（供 shutdown.js 清理）。
    host._timer = null; host._heartbeatTimer = null; host._upgradeTimer = null; host._initialCheckTimer = null;

    host._lastHeartbeatAt = Date.now();
    host._heartbeatStalls = 0;
    host._heartbeatBeat = host._heartbeatBeat || 0;
    if (host.lanDaemonEnabled()) {
      host._syncLanState();
      const lrt = host._ensureLanRuntime(true);
      if (host.logger && host.logger.info) host.logger.info('[lan] L3b 模式：lan-daemon ' + (lrt.mode === 'daemon' ? ('已就绪 pid=' + (lrt.spawned || '(既有)')) : ('未就绪 mode=' + lrt.mode)));
    } else {
      host.lan.reconcile().catch(() => {});
      host.lan.syncFrpc();
    }
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

module.exports = { _bootstrap, _registerFixedPorts, _bindNativeDshCommand, _refreshEnvironmentForm };
