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

  // R8-进程管理：daemon 模式的域摘要原本从 ManagedRegistry 读，那张表已删
  // （全仓零 register 调用，从来是空的，此分支从未成功过）。
  // 现 daemon 模式明确返回「无域摘要」——进程相位由壳的进程表持有，
  // 域摘要是业务投影，不该由进程管理层提供。
  routerDomainSummary() {
    const d = depsOf(this);
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
