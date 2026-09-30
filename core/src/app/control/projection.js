'use strict';

// app/control/projection.js —— 聚合视图投影工厂（真 ctor 注入）：createProjection(deps)
// 持有三个 sync 视图实现（纯视图投影，不驱动启停），假 deps 可直测。

function createProjection(deps) {
  const g = deps || {};
  const mgr = () => (typeof g.getLifecycleManager === 'function' ? g.getLifecycleManager() : null);
  const state = () => (typeof g.getState === 'function' ? g.getState() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);

  /** 把守卫对 DSH 的观测合成到 lifecycleManager 的 dsh 项。 */
  function syncDshView() {
    const lm = mgr();
    if (!lm) return;
    const dsh = lm.get('dsh');
    if (!dsh) return;
    const st = state();
    const e = st.dshEntry();
    const ph = String(st.phase() || '');
    const desiredRunning = st.desired() === 'running';
    const ob = (e && e.lastObserved) || null;
    const proc = (e && e.process) || null;
    const portUp = !!(proc && proc.lastProbeOk) || !!(ob && ob.ok);
    const httpOk = !(proc && proc.lastProbeHttpOk === false);
    const healthy = portUp && httpOk;
    const errText = !portUp ? '端口未监听' : (httpOk ? null : 'HTTP 不健康');
    const at = (proc && proc.lastProbeAt) || (ob && ob.at) || null;
    if (desiredRunning) {
      dsh.wantRunning();
      dsh._monitoring = true;
      if (at) dsh.lastProbeAt = at;
      if (ph === 'RUNNING') {
        dsh._setPhase('running');
        dsh.startedAt = dsh.startedAt || new Date().toISOString();
        dsh.healthy = healthy;
        dsh.error = errText;
      } else if (ph === 'STARTING' || ph === 'RESTARTING') {
        dsh._setPhase('starting');
        dsh.healthy = healthy;
        dsh.error = errText;
      } else if (ph === 'BACKOFF') {
        dsh._setPhase('starting');
        dsh.healthy = false; // 退避中进程未提供服务；不落 false 会沿用上一拍的 true 谎报健康
        dsh.error = '启动退避中';
      } else {
        dsh._setPhase('stopped');
        dsh.healthy = false;
        dsh.error = errText;
      }
    } else {
      dsh.desired = 'stopped';
      dsh._monitoring = false;
      dsh._setPhase('stopped');
      dsh.healthy = false;
    }
    dsh.guardian = st.guardian();
  }

  /** router 生命周期视图同步。 */
  function syncRouterView(o) {
    const lm = mgr();
    const lc = lm ? lm.get('router') : null;
    if (!lc) return;
    const m = reg();
    const e = (m && typeof m.get === 'function') ? m.get('router-daemon') : null;
    const ob = (e && e.lastObserved) || null;
    const ok = !!(o && o.ok !== undefined) ? !!(o && o.ok) : !!(ob && ob.ok);
    const err = (o && o.error !== undefined) ? o.error : ((ob && ob.error) || 'router-daemon 未就绪');
    const at = (o && o.at) || (ob && ob.at) || new Date().toISOString();
    const wantRunning = lc.desired === 'running' || lc._monitoring === true;
    lc.lastProbeAt = at;
    if (!wantRunning) {
      if (lc.phase !== 'stopped') lc._setPhase('stopped');
      lc.healthy = false;
      return;
    }
    if (ok) {
      if (lc.phase !== 'running') lc._setPhase('running');
      lc.error = null;
    } else if (lc.phase !== 'running') {
      if (lc.phase !== 'starting') lc._setPhase('starting');
      lc.error = err;
    } else {
      lc.error = err;
    }
    lc.healthy = ok;
  }

  /** instances 聚合视图真实化（每心跳刷新一次）。 */
  function syncInstancesView() {
    const lm = mgr();
    const lc = lm ? lm.get('instances') : null;
    if (!lc) return;
    lc.wantRunning();
    lc._monitoring = true;
    lc.healthy = true;
    lc.error = null;
    lc.lastProbeAt = new Date().toISOString();
    if (lc.phase !== 'running') {
      lc._setPhase('running');
      lc.startedAt = lc.startedAt || new Date().toISOString();
    }
  }

  return { syncDshView, syncRouterView, syncInstancesView };
}

module.exports = { createProjection };
