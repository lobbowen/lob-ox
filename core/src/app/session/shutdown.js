'use strict';

const platform = require('../../platform/os/index');
const distribution = require('../../platform/distribution');

function abortInflightNpm(host, reason) {
    let n = 0;
    try {
      n = distribution.killInflightNpm(reason);
    } catch (e) {
      host.logger && host.logger.warn && host.logger.warn('shutdown abortInflightNpm: ' + ((e && e.message) || e));
      return 0;
    }
    if (n > 0) {
      host.logger && host.logger.warn && host.logger.warn('[shutdown] 中止在途 npm 任务 ' + n + ' 个（' + reason + '）：本次安装/卸载未完成，可在守卫恢复后重新发起');
      host.events && host.events.append('shutdown_npm_aborted', { count: n, reason });
    }
    return n;
}

function shutdown(host) {
    if (host._stopping) return host._shutdownPromise || Promise.resolve();
    host._stopping = true;
    if (!host._shellHalted && !host._sessionHalting()) {
      host._shellHalted = true;
      try { host.events.append('shell_halt_on_external_stop', {}); } catch {}
    }
    host.lifecycle.beginShutdown();
    host.events.append('guard_exit', {});
    host.logger.info('guard shutting down');
    host.writeState(true);
    if (host._beatScheduler) host._beatScheduler.stop();
    if (host._killTimer) clearTimeout(host._killTimer);
    if (host._adoptKillTimer) clearTimeout(host._adoptKillTimer);
    abortInflightNpm(host, 'guard-shutdown');
    if (host.api) {
      try {
        host.api.close();
      } catch {}
    }
    host._shutdownPromise = (async () => {
      try {
        if (host.lifecycleManager) {
          try {
            const rlc = host.lifecycleManager.get('router');
            if (rlc && host._routerDaemonActive()) {
              rlc._monitoring = false;
            }
          } catch {}
          await host.lifecycleManager.stopAll('guard-shutdown', { exclude: ['dsh'] });
        } else {
          try { if (host.lan) await host.lan.shutdown(); } catch (e) { host.logger.warn && host.logger.warn('lan shutdown: ' + (e && e.message)); }
          try { if (host.router) await host.router.stop(); } catch (e) { host.logger.warn && host.logger.warn('router stop: ' + (e && e.message)); }
        }
      } catch (e) { host.logger.warn && host.logger.warn('lifecycle stopAll: ' + (e && e.message)); }
    })();
    return host._shutdownPromise;
}

async function shutdownAll(host) {
    if (host._sessionHalting()) return { ok: true, already: true, sessionState: host._sessionState };
    host._setSessionState('stopping');
    host._shellHalted = true;
    try { host.writeState(true); } catch (e) { host.logger.warn && host.logger.warn('shutdownAll persist shellHalted: ' + e.message); }
    host.logger.info('[session] 退出流程开始：停止全部被管对象…');
    host.events && host.events.append('shutdown_all', {});
    abortInflightNpm(host, 'session-exit');
    if (host._beatScheduler) host._beatScheduler.stop();
    host._stopMainDsh();
    await host._stopAllSandboxes();
    const stopDaemon = async (kind) => {
      try {
        const lc = host._daemonLifecycle(kind);
        if (!lc) return;
        const r = await lc.stop();
        if (r && r.ok === false) {
          host.logger.warn && host.logger.warn('shutdownAll stop ' + kind + ' 未完成: ' + (r.error || '未知'));
          host.events && host.events.append('shutdown_daemon_stop_incomplete', { kind, pid: r.stopped || null, error: r.error || null });
        }
      } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop ' + kind + ': ' + e.message); }
    };
    await stopDaemon('router');
    await stopDaemon('lan');
    host._setSessionState('stopped');
    host.writeState(true);
    host.events && host.events.append('session_stopped', {});
    host.logger.info('[session] 被管对象已全部停止；等待外部所有者（壳/systemd）停止守卫进程');
    return { ok: true, sessionState: 'stopped' };
}

function _stopMainDsh(host) {
    try {
      if (host._mChild() || host._mAdoptPid()) { host.stopProcess('session_stop'); }
    } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop main: ' + e.message); }
}

async function _stopAllSandboxes(host) {
    const insts = host.instances ? host.instances.all() : [];
    const sandboxes = insts.filter((i) => i.domain === 'sandbox' && i.id !== 'main');
    for (const inst of sandboxes) {
      let stopped = false;
      try {
        stopped = (await platform.service.current().stopUnit('dsh-web@' + inst.id,
          Object.assign({ timeoutMs: 20000 }, host.instances.launchCtx(inst)))) === true;
      } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop sandbox ' + inst.id + ': ' + (e && e.message)); }
      if (!stopped) {
        host.logger.warn && host.logger.warn('shutdownAll stop sandbox ' + inst.id + ' 未确认停止，保留原 phase');
        host.events && host.events.append('shutdown_sandbox_stop_incomplete', { id: inst.id });
        continue;
      }
      try { if (inst.state) inst.state.phase = 'STOPPED'; } catch {}
    }
    if (sandboxes.length) { try { host.instances.save(); } catch {} }
}

module.exports = { shutdown, shutdownAll, _stopMainDsh, _stopAllSandboxes };
