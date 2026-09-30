'use strict';

// app/facade/router.js —— router 域只读门面（写动作 setRouterRunning 在 app/domain-actions/router.js）。
// 只读白名单（不得引入写动词）：routerDaemonActive / routerStatusView / routerProviders / routerStatus / routerDomainSummary，
//   另含只读访问器 routerApi。导出 { methods }，方法经按 host 缓存的惰性 deps（WeakMap）取事实，唯一的 this 在 depsOf(this)。

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
      // 同模块兄弟方法经 host 上的既有安装转发（外部覆写 host 方法仍生效）。
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
    // 仅当本守卫期望 daemon 运行（routerAutostart）且管理锁在手且 ctl 端口监听者为
    // router-daemon 时，才视为 daemon 监督模式（routerApi/门面/ctl 生效）。
    // 绝不因全局 ctl 端口被占就把任意 Supervisor 实例（含测试内嵌实例）误判为监督模式——
    // 否则测试 api 调用会经 ctl 打到线上 daemon。
    try {
      const cfg = d.config();
      if (!cfg || cfg.routerAutostart !== true) return false;
      if (!d.daemons().managed()) return false;
      return d.daemons().routerActive();
    } catch { return false; }
  },

  /** GET /router/status 视图：daemon 监督模式下取 daemon 实时状态（异步），否则本地视图（同步）。 */
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
    // local() 兜底仅限 daemon 全挂应急，标注 stale 来源（正常监督模式前端不消费副本）
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

  /** 域摘要（目录合成视图）：daemon 监督模式取目录 router-daemon 项的 domainSummary
   *  （监督拍经 ctl 拉取的只读缓存，目录只存引用）；内嵌模式取本地 RouterService 实时摘要。 */
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

  // router 控制通道门面：守卫 API/视图统一从这里取。
  // 本方法在此文件以保证对 ctl 的依赖单向（ctl/facades 不调本文件的 routerDaemonActive）。
  // daemon 在跑则转发 ctl（POST /ctl {method,args}）——写即 daemon 生效、读即 daemon 最新；
  // daemon 未跑则走守卫本地实例（内嵌回退路径）。
  routerApi() {
    const d = depsOf(this);
    if (d.routerDaemonActive()) {
      if (!d.readRouterFacade()) d.writeRouterFacade(d.ctl().routerFacade());
      return d.readRouterFacade();
    }
    return d.router();
  },
} };
