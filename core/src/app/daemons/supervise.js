'use strict';

const pidlook = require('../../platform/os/pidlookup');

const ROUTER_SUMMARY_TIMEOUT_MS = 5000;

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      stopping: () => host._stopping,
      exitIntended: () => host._exitIntended(),
      lifecycleManager: () => host.lifecycleManager,
      config: () => host.config,
      daemons: () => host.daemons,
      control: () => host.control,
      views: () => host.views,
      managedObjects: () => host.managedObjects,
      ctl: () => host.ctl,
      events: () => host.events,
      logger: () => host.logger,
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    async _daemonSuperviseOnce(kind) {
      const d = depsOf(this);
      if (d.stopping()) return { ok: false };
      if (d.exitIntended()) return { ok: false, error: 'exit intended' };
      try {
        if (kind === 'router') {
          const wantRunning = d.config().routerAutostart === true;
          const rlc = d.lifecycleManager() ? d.lifecycleManager().get('router') : null;
          if (!wantRunning) return { ok: d.daemons().routerActive() };
          if (!d.daemons().managed()) return { ok: d.daemons().routerActive() };
          const rlcx = d.daemons().lifecycle('router');
          if (rlcx && typeof rlcx.classify === 'function') {
            const c = rlcx.classify();
            if (c && c.mode === 'external') {
              d.logger() && d.logger().warn && d.logger().warn('[router] 监督：ctl ' + d.ctl().routerPort() + ' 被外部进程占用（pid=' + c.owner + '），不接管不拉起');
              return { ok: false };
            }
          }
          if (d.daemons().routerActive()) {
            try { d.control().syncRouterView({ ok: true }); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('router view sync: ' + (e && e.message)); }
            try {
              if (d.views().routerDaemonActive() && d.managedObjects()) {
                const s = await d.ctl().call(d.ctl().routerPort(), 'domainSummary', [], ROUTER_SUMMARY_TIMEOUT_MS);
                const e = d.managedObjects().get('router-daemon');
                if (e && s && typeof s === 'object') {
                  e.domainSummary = Object.assign({ fetchedAt: Date.now() }, s);
                }
              }
            } catch (e2) { d.logger() && d.logger().debug && d.logger().debug('router 域摘要拉取失败: ' + ((e2 && e2.message) || e2)); }
            return { ok: true };
          }
          const rt = d.daemons().ensureRouterRuntime(true);
          if (rt.mode === 'daemon' && rt.spawned) {
            d.events().append('router_daemon_supervised', { pid: rt.spawned });
            if (d.logger() && d.logger().warn) d.logger().warn('[router] 监督：router-daemon 失联，已重新拉起 pid=' + rt.spawned);
            if (rlc) { rlc._setPhase('starting'); }
            setTimeout(() => {
              const up = pidlook.findListeningPid(d.ctl().routerPort());
              try { d.control().syncRouterView({ ok: !!up, error: up ? null : 'router-daemon 拉起后未就绪' }); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('router view sync: ' + (e && e.message)); }
            }, 3000);
          } else if (rt.mode === 'error') {
            if (d.logger() && d.logger().warn) d.logger().warn('[router] 监督拉起失败: ' + (rt.error || '未知'));
          }
          return { ok: false };
        }
        if (!d.daemons().enabled()) return { ok: d.daemons().lanActive() };
        d.daemons().syncLanState();
        if (d.daemons().lanActive()) return { ok: true };
        const rt = d.daemons().ensureLanRuntime(true);
        if (rt.mode === 'daemon' && rt.spawned) {
          if (d.logger() && d.logger().warn) d.logger().warn('[lan] 监督：lan-daemon 失联，已重新拉起 pid=' + rt.spawned);
        } else if (rt.mode === 'error') {
          if (d.logger() && d.logger().warn) d.logger().warn('[lan] 监督拉起失败: ' + (rt.error || '未知'));
        }
        return { ok: false };
      } catch (e) {
        if (d.logger() && d.logger().warn) d.logger().warn('[' + kind + '] 监督异常: ' + (e && e.message));
        return { ok: false };
      }
    },
  },
};
