'use strict';

function createProjection(deps) {
  const g = deps || {};
  const mgr = () => (typeof g.getLifecycleManager === 'function' ? g.getLifecycleManager() : null);
  const state = () => (typeof g.getState === 'function' ? g.getState() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);

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
    
    const alive = !!(ob && ob.ok);
    const at = (ob && ob.at) || null;
    if (desiredRunning) {
      dsh.wantRunning();
      dsh._monitoring = true;
      
      if (at) dsh.lastProbeAt = at;
      if (ph === 'RUNNING') {
        dsh._setPhase('running');
        dsh.startedAt = dsh.startedAt || new Date().toISOString();
        dsh.healthy = alive;
        dsh.error = alive ? null : '进程未运行';
      } else if (ph === 'STARTING') {
        dsh._setPhase('starting');
        dsh.healthy = false;
        dsh.error = '启动中（startsecs 窗口内）';
      } else if (ph === 'FAILED') {
        dsh._setPhase('failed');
        dsh.healthy = false;
        dsh.error = '启动反复失败：已停止自动重启，等待人工重试';
      } else {
        dsh._setPhase('stopped');
        dsh.healthy = false;
        dsh.error = alive ? null : '未运行';
      }
    } else {
      dsh.desired = 'stopped';
      dsh._monitoring = false;
      dsh._setPhase('stopped');
      dsh.healthy = false;
    }
    dsh.guardian = st.guardian();
  }

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

  function syncInstancesView() {
    const lm = mgr();
    const lc = lm ? lm.get('instances') : null;
    if (!lc) return;
    lc.wantRunning();
    lc._monitoring = true;
    
    const snap = typeof lc.snapshot === 'function' ? lc.snapshot() : null;
    const detail = snap ? snap.detail : null;
    lc.lastProbeAt = new Date().toISOString();
    if (detail) {
      lc.healthy = true;
      lc.error = null;
      if (lc.phase !== 'running') {
        lc._setPhase('running');
        lc.startedAt = lc.startedAt || new Date().toISOString();
      }
    } else {
      lc.healthy = false;
      lc.error = '实例登记表读数不可用';
      if (lc.phase !== 'stopped') lc._setPhase('stopped');
    }
  }

  return { syncDshView, syncRouterView, syncInstancesView };
}

module.exports = { createProjection };
