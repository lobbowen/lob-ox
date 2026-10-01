'use strict';

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      daemons() { return host.daemons; },
      router() { return host.router; },
      logger() { return host.logger; },
      managedObjects() { return host.managedObjects; },
      ctl() { return host.ctl; },
      routerDaemonActive() { return host.routerDaemonActive(); },
      routerApi() { return host.routerApi(); },
      routerStatus() { return host.routerStatus(); },
      readRouterFacade() { return host._routerFacade; },
      writeRouterFacade(v) { host._routerFacade = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = { methods: {

  routerDaemonActive() {
    const d = depsOf(this);
    try {
      const cfg = d.config();
      if (!cfg || cfg.routerAutostart !== true) return false;
      if (!d.daemons().managed()) return false;
      return d.daemons().routerActive();
    } catch { return false; }
  },

  async routerStatusView() {
    const d = depsOf(this);
    if (d.routerDaemonActive()) {
      try {
        const st = await d.routerApi().status();
        return { running: !!(st && st.running), autostart: d.config().routerAutostart === true, ...(st || {}) };
      } catch (e) {
        if (d.logger() && d.logger().warn) d.logger().warn('router status 远程失败，回退本地: ' + e.message);
      }
    }
    return d.routerStatus();
  },

  routerProviders() {
    const d = depsOf(this);
    const presets = d.router().constructor.presets();
    const local = () => ({ presets, providers: d.router().listProviders(), proxyApps: d.router().proxyApps(), _stale: true, _staleReason: 'daemon 失联/ctl 失败应急视图（守卫内嵌只读副本）' });
    if (!d.routerDaemonActive()) return local();
    const rt = d.routerApi();
    return Promise.all([Promise.resolve(rt.listProviders()), Promise.resolve(rt.proxyApps())])
      .then(([providers, proxyApps]) => ({ presets, providers, proxyApps }))
      .catch((e) => {
        if (d.logger() && d.logger().warn) d.logger().warn('routerProviders 远程取数失败，回退本地视图: ' + e.message);
        return local();
      });
  },

  routerStatus() {
    const d = depsOf(this);
    const st = d.router().status();
    return { running: !!st.running, autostart: d.config().routerAutostart === true, ...st };
  },

  routerDomainSummary() {
    const d = depsOf(this);
    if (d.routerDaemonActive()) {
      try {
        const mo = d.managedObjects();
        const e = mo && typeof mo.get === 'function' ? mo.get('router-daemon') : null;
        const s = e && e.domainSummary;
        if (s) return { ok: true, source: 'directory', summary: s };
        return { ok: false, source: 'directory', error: '目录尚无 router 域摘要（等待首个监督拍）' };
      } catch (e2) {
        return { ok: false, source: 'directory', error: (e2 && e2.message) || String(e2) };
      }
    }
    try {
      const r = d.router();
      const s = r && typeof r.domainSummary === 'function' ? r.domainSummary() : null;
      return { ok: true, source: 'embedded', summary: s };
    } catch (e2) {
      return { ok: false, source: 'embedded', error: (e2 && e2.message) || String(e2) };
    }
  },

  routerApi() {
    const d = depsOf(this);
    if (d.routerDaemonActive()) {
      if (!d.readRouterFacade()) d.writeRouterFacade(d.ctl().routerFacade());
      return d.readRouterFacade();
    }
    return d.router();
  },
} };
