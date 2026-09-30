'use strict';

// daemon 保活单拍（router/lan 心跳监督）。
// 导出形态 { methods }，方法名与体逐字保留；实现体经按 host 缓存的惰性 deps（WeakMap）取事实。
const pidlook = require('../../platform/os/pidlookup');

/** 监督拍内拉取 router 域摘要的超时（ms）：必须远小于心跳拍对「阻塞」的容忍度（_ctlCall 默认 120s
 *  会阻塞整条唯一心跳），摘要只是只读缓存，失败即降级。 */
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
    /** 唯一心跳驱动的 daemon 保活单拍：router/lan-daemon「业务需要它 + 失联即拉起」，由 ManagedRegistry.heartbeat
     *  经 adapter 调用（节流约 30s）；守卫重启不影响 daemon（进程独立）。
     *  契约 域 B：两 daemon 是基础设施（能力自愈），本方法是保活而非守护触发用户意图，两分支均不写
     *  guardian_action / restartCount（G-1/G-2）。@returns {ok:boolean} daemon 当前在线（heartbeat 统一写入目录实然）。 */
    async _daemonSuperviseOnce(kind) {
      const d = depsOf(this);
      if (d.stopping()) return { ok: false };
      // INV-S1 全域/E-3：有退出意图则不再监督拉起 router/lan daemon（单源谓词）。
      if (d.exitIntended()) return { ok: false, error: 'exit intended' };
      try {
        if (kind === 'router') {
          // 运行意图唯一源是持久化 config。rlc.desired 只是同一次写口的内存镜像，读它等于承认
          //   第二真相：镜像已置 running 而 config 未落库的半程状态会被无限重拉，用户看到「关不掉」。
          const wantRunning = d.config().routerAutostart === true;
          // rlc 在此只做视图回填（拉起后置相位），不参与「该不该活着」的判定。
          const rlc = d.lifecycleManager() ? d.lifecycleManager().get('router') : null;
          if (!wantRunning) return { ok: d.daemons().routerActive() };
          if (!d.daemons().managed()) return { ok: d.daemons().routerActive() }; // 异主隔离：监督不介入
          // 代际分类（DaemonLifecycle.classify）：只按 cmdline 判 active 无法区分本守卫 daemon 与外部
          // 同名 daemon，故识别 external（ctl 被外部/异代际进程占用）情形。
          const rlcx = d.daemons().lifecycle('router');
          if (rlcx && typeof rlcx.classify === 'function') {
            const c = rlcx.classify();
            if (c && c.mode === 'external') {
              // 异主隔离：只告警不接管；不发 guardian_action（契约 域 B / G-2）。
              d.logger() && d.logger().warn && d.logger().warn('[router] 监督：ctl ' + d.ctl().routerPort() + ' 被外部进程占用（pid=' + c.owner + '），不接管不拉起');
              return { ok: false };
            }
          }
          if (d.daemons().routerActive()) {
            try { d.control().syncRouterView({ ok: true }); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('router view sync: ' + (e && e.message)); }
            // router 域摘要入目录（黑盒摘要引用，只读缓存；拉取失败仅降级，不影响监督）
            try {
              if (d.views().routerDaemonActive() && d.managedObjects()) {
                // 本 await 位于心跳串行 for 循环内，超时取默认 120s 会阻塞同拍后续的 lan/主实例/沙箱收敛。
                // 必须直接走 _ctlCall 的 timeoutMs 形参：门面 proxy 签名是 fn=(...args)=>_ctlCall(port,prop,args)，
                // 把 {timeoutMs} 当方法参数传会被送到 daemon 的 domainSummary 而非当超时用。
                const s = await d.ctl().call(d.ctl().routerPort(), 'domainSummary', [], ROUTER_SUMMARY_TIMEOUT_MS);
                const e = d.managedObjects().get('router-daemon');
                if (e && s && typeof s === 'object') {
                  e.domainSummary = Object.assign({ fetchedAt: Date.now() }, s);
                }
              }
            } catch (e2) { d.logger() && d.logger().debug && d.logger().debug('router 域摘要拉取失败: ' + ((e2 && e2.message) || e2)); }
            return { ok: true };
          }
          // 契约 域 B / G-1+G-2：保活不判 guardian、不写 restartCount、不发 guardian_action
          //   （restartCount 属用户意图语义，基础设施不适用）；运维由下方 warn 日志看到被重新拉起。
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
        // kind === 'lan'
        // 业务条件（契约 域 B / G-1）：lan 该不该活着由结构性部署选择决定，不是用户开关——
        //   config.lanDaemon 在壳部署时选定 daemon 模式或内嵌模式，无面板入口、用户无需知情。
        if (!d.daemons().enabled()) return { ok: d.daemons().lanActive() };
        d.daemons().syncLanState();
        if (d.daemons().lanActive()) return { ok: true };
        // 保活（失联即拉起）：不判 guardian、不写 restartCount、不发 guardian_action（契约 G-1/G-2），
        //   基础设施不存在用户意图轴；运维由下方 warn 日志看到 lan 被重新拉起。
        //   id 平面（G-5）：本分支工作于 B 平面（kind='lan'，adapter 在 assembly/compose/domains.js 注册为
        //   'lan-daemon'），目录 entry 属 A 平面；两平面经该显式映射，基础设施路径无需再取目录 entry。
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
