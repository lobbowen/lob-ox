'use strict';

// app/domain-actions/router.js —— router 域写动作（facade 只读，写动作下沉至此）。
// setRouterRunning 改 config + 持久化 + 生命周期镜像，是业务写动作；留在门面会让 api 经
// facade 直接改状态，绕过生命周期/事件记账。实现只经注入的惰性 deps 取事实（装配期 host
// 尚未就绪，故用 getter）；装配侧（app/assembly/facets.js）把方法平铺装到 host，消费面不变。

/** setRouterRunning 工厂。
 *  @param deps { getLifecycleManager, getDaemons, getConfig, getState, getViews, getRouter } 全为惰性取值。 */
function createRouterActions(deps) {
  const g = deps || {};
  return {

    async setRouterRunning(on) {
      const lifecycleManager = g.getLifecycleManager();
      const daemons = g.getDaemons();
      const config = g.getConfig();
      const state = g.getState();
      const views = g.getViews();
      const router = g.getRouter();
      // 统一生命周期视图同步：router 启停状态镜像到 lifecycleManager（归一化：启停路径收敛）
      const rlc = lifecycleManager ? lifecycleManager.get('router') : null;
      if (on) {
        // 优先独立 router-daemon（detached，守卫重启不影响）；daemon 不可用退回内嵌
        const rt = daemons.ensureRouterRuntime(true);
        if (rt.mode === 'daemon') {
          // daemon 模式下守卫不得写 providers.json：纪律本体在 _ensureRouterRuntime（靠返回值判定），
          // 但本处是用户显式开启路径，须同样调 disableRouterPersist，否则双写 providers.json（漂移 ghost）。
          daemons.disableRouterPersist();
          config.routerAutostart = true;
          state.persistConfigPatch({ routerAutostart: true });
          if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (!rt.active) rlc._setPhase('starting'); /* healthy 由 _supervise mirror 观测置位 */ }
          return { ok: true, mode: rt.mode, ...views.routerStatus() };
        }
        const r = await router.start();
        config.routerAutostart = true;
        state.persistConfigPatch({ routerAutostart: true });
        if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (r.ok === false) { rlc._setPhase('stopped'); rlc.error = r.error; } /* healthy 由 _supervise mirror 观测置位 */ }
        return { ok: r.ok !== false, error: r.error, mode: rt.mode, ...views.routerStatus() };
      }
      // 停止：若 daemon 在跑则停 daemon；否则停内嵌 router
      const rt = daemons.ensureRouterRuntime(false);
      if (rt.mode === 'daemon' && rt.stopping) {
        config.routerAutostart = false;
        state.persistConfigPatch({ routerAutostart: false });
        if (rlc) { rlc.wantStopped(); rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
        return { ok: true, mode: 'daemon', ...views.routerStatus() };
      }
      const r = router.stop();
      config.routerAutostart = false;
      state.persistConfigPatch({ routerAutostart: false });
      if (rlc) { rlc.wantStopped(); rlc._monitoring = false; rlc._setPhase('stopped'); rlc.healthy = false; }
      return { ok: r.ok !== false, already: !!r.already, mode: 'embedded', ...views.routerStatus() };
    },
  };
}

module.exports = { createRouterActions };
