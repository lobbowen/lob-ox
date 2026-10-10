'use strict';

const { ManagedLifecycle } = require('./entry');
const { kindMeta } = require('./registry');

function capsOf(objectKind) {
  const m = kindMeta(objectKind);
  if (!m) return { startable: true, guardable: true };
  return { startable: m.startable !== false, guardable: m.guardable !== false };
}

function registerAll(mgr, deps) {
  const { router, lan, instances, supervisor, pluginManager } = deps;
  const logger = (deps.logger) || null;

  if (router) {
    const sup = deps && deps.supervisor;
    const rlc = new ManagedLifecycle({
      id: 'router',
      ...capsOf('router-daemon'),
      kind: 'router',
      name: '智能路由',
      logger,
      start: async () => (sup && typeof sup.setRouterRunning === 'function') ? sup.setRouterRunning(true) : { ok: false, error: '缺 setRouterRunning 写口：启停不得绕过 config 持久化' },
      stop: async () => {
        if (sup && sup._stopping) return { ok: true, already: true, reason: 'guard-shutdown 不停 daemon' };
        return (sup && typeof sup.setRouterRunning === 'function') ? sup.setRouterRunning(false) : { ok: false, error: '缺 setRouterRunning 写口：停止须同时清 config 持久化' };
      },
      status: () => (sup && typeof sup.routerStatus === 'function') ? sup.routerStatus() : (router.status ? router.status() : null),
    });
    mgr.register(rlc);
  }

  if (lan) {
    const llc = new ManagedLifecycle({
      id: 'lan',
      ...capsOf('lan-daemon'),
      kind: 'lan',
      name: '远程控制',
      logger,
      // start 的结果必须来自真实执行：reconcile/syncFrpc 各自如实返回 ok，任一失败即 ok:false（此前恒 true）。
      start: async () => {
        try {
          const rec = await lan.reconcile();
          if (rec && rec.ok === false) return { ok: false, error: 'reconcile: ' + (rec.error || '未知失败') };
          const fr = lan.syncFrpc ? lan.syncFrpc() : { ok: true };
          if (fr && fr.ok === false) return { ok: false, error: fr.error || 'frpc 同步失败', needInstall: !!fr.needInstall };
          return { ok: true, proxies: fr && fr.proxies };
        } catch (e) { return { ok: false, error: e.message }; }
      },
      stop: async () => {
        if (deps && deps.supervisor && deps.supervisor._stopping) return { ok: true, already: true, reason: 'guard-shutdown 不停 lan' };
        try { lan.shutdown(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
      },
      status: () => lan.status ? lan.status() : null,
    });
    mgr.register(llc);
  }

  if (instances) {
    const ilc = new ManagedLifecycle({
      id: 'instances',
      kind: 'instances',
      name: '实例管理',
      startable: false,
      guardable: false,
      logger,
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: () => {
        try {
          const arr = (instances && typeof instances.all === 'function' && instances.all()) || [];
          const sand = arr.filter((i) => (i.domain || i.kind) === 'sandbox' || (i.domain !== 'native' && i.id !== 'main'));
          const running = sand.filter((i) => i.state && i.state.phase === 'RUNNING').length;
          return { count: sand.length, running };
        } catch { return null; }
      },
    });
    mgr.register(ilc);
  }

  if (supervisor) {
    const dshGuardian = (supervisor && typeof supervisor.mainGuardian === 'function')
      ? supervisor.mainGuardian() : false;
    const dsh = new ManagedLifecycle({
      id: 'dsh',
      ...capsOf('dsh'),
      guardian: dshGuardian,
      kind: 'dsh',
      name: 'DeepSeek Harness',
      logger,
      start: async () => supervisor.setDesired ? supervisor.setDesired('running') : { ok: false, error: 'unsupported' },
      restart: async () => supervisor.requestRestart ? supervisor.requestRestart() : { ok: false, error: 'unsupported' },
      stop: async () => supervisor.setDesired ? supervisor.setDesired('stopped') : { ok: false, error: 'unsupported' },
      status: () => supervisor.statusSummary ? supervisor.statusSummary() : null,
    });
    mgr.register(dsh);
    if (supervisor.desired === 'running') dsh.wantRunning();
    const ph = String(supervisor.phase || '');
    if (ph === 'RUNNING') { dsh._setPhase('running'); dsh.healthy = true; dsh.startedAt = dsh.startedAt || new Date().toISOString(); }
    else if (ph === 'STARTING') { dsh._setPhase('starting'); }
    else if (ph === 'FAILED') { dsh._setPhase('failed'); dsh.error = '启动反复失败：已停止自动重启'; }
    dsh._monitoring = true;
  }

  // 壳（shell）由 Rust 底座单方面拥有生命周期：底座监督并上报，内核只作只读聚合。
  // 内核绝不反向监督或以任何方式拉起其父进程（壳）——倒挂修复。故此处不登记
  // shellWatchdog 节拍、不做 tick monkey-patch 写回相位/重启计数。
  if (pluginManager) {
    const plc = new ManagedLifecycle({
      id: 'plugins',
      kind: 'plugins',
      name: '插件管理',
      ...capsOf('plugin'),
      logger,
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      status: () => null,
    });
    mgr.register(plc);
  }

  return mgr;
}

module.exports = { registerAll };
