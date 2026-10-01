'use strict';

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
      const rlc = lifecycleManager ? lifecycleManager.get('router') : null;
      if (on) {
        const rt = daemons.ensureRouterRuntime(true);
        if (rt.mode === 'daemon') {
          daemons.disableRouterPersist();
          config.routerAutostart = true;
          state.persistConfigPatch({ routerAutostart: true });
          if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (!rt.active) rlc._setPhase('starting');  }
          return { ok: true, mode: rt.mode, ...views.routerStatus() };
        }
        const r = await router.start();
        config.routerAutostart = true;
        state.persistConfigPatch({ routerAutostart: true });
        if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc.startedAt = rlc.startedAt || new Date().toISOString(); if (r.ok === false) { rlc._setPhase('stopped'); rlc.error = r.error; }  }
        return { ok: r.ok !== false, error: r.error, mode: rt.mode, ...views.routerStatus() };
      }
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
