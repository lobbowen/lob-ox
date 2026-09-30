'use strict';

// 模块适配器：把现有模块对象包成 ManagedLifecycle 注册到 LifecycleManager。
// 只做翻译（映射 start/stop/状态），不改模块内部逻辑。

const { ManagedLifecycle } = require('./entry');
const { kindMeta } = require('./registry');

/** 能力位取自受管类型表 MANAGED_KINDS（声明的单一源）：此处注入、manager 执法、
 *  snapshot 供 UI 灰化；未登记类型按可启停/可守护保守处理（不误禁）。 */
function capsOf(objectKind) {
  const m = kindMeta(objectKind);
  if (!m) return { startable: true, guardable: true };
  return { startable: m.startable !== false, guardable: m.guardable !== false };
}

/** 注册全部模块到 LifecycleManager（supervisor.start 时调用，供统一启停/状态视图）；
 *  周期拉起不在此（守卫 daemon 监督 tick / 实例 watchdog+guardian）。deps = 现有模块对象。 */
function registerAll(mgr, deps) {
  const { router, lan, instances, supervisor, pluginManager } = deps;
  const logger = (deps.logger) || null;

  // 1. 智能路由作为一个生命周期单元注册；其下反代实例是子层（router 自治），不在本表展开。
  // 启停只走 supervisor.setRouterRunning（它同时持久化 routerAutostart，内嵌回退也在其内部），
  // 不得直接 start() 内嵌实例——否则双占 ctl 43107，且运行意图落在没写库的对象上。
  if (router) {
    const sup = deps && deps.supervisor;
    // 契约 G-1：router-daemon 是基础设施，不设 guardian——失联由保活路径无条件拉起（_daemonSuperviseOnce）。
    const rlc = new ManagedLifecycle({
      id: 'router',
      ...capsOf('router-daemon'),
      kind: 'router',
      name: '智能路由',
      logger,
      start: async () => (sup && typeof sup.setRouterRunning === 'function') ? sup.setRouterRunning(true) : { ok: false, error: '缺 setRouterRunning 写口：启停不得绕过 config 持久化' },
      // 守卫自身 shutdown（_stopping=true）不得停独立 daemon：守卫退出不影响被管模块，仅显式用户停止才停。
      stop: async () => {
        if (sup && sup._stopping) return { ok: true, already: true, reason: 'guard-shutdown 不停 daemon' };
        return (sup && typeof sup.setRouterRunning === 'function') ? sup.setRouterRunning(false) : { ok: false, error: '缺 setRouterRunning 写口：停止须同时清 config 持久化' };
      },
      // detail 走守卫真实 router 状态视图（daemon 模式经 ctl 取实时态）
      status: () => (sup && typeof sup.routerStatus === 'function') ? sup.routerStatus() : (router.status ? router.status() : null),
    });
    mgr.register(rlc);
  }

  // 2. 远程控制（LanManager：relay + frpc）
  if (lan) {
    // 同域 B 契约 G-1：lan-daemon 不设 guardian。
    // B 平面 id='lan'（历史命名，保持稳定以免破坏 API/测试消费面），A 平面目录 id='lan-daemon'，
    // 两平面经 _daemonSuperviseOnce('lan') <-> registerAdapter('lan-daemon') 显式映射（契约 G-5）。
    const llc = new ManagedLifecycle({
      id: 'lan',
      ...capsOf('lan-daemon'),
      kind: 'lan',
      name: '远程控制',
      logger,
      start: async () => { try { lan.reconcile().catch(()=>{}); lan.syncFrpc(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
      // 守卫 shutdown 同样不停 lan（relay 由独立 lan-daemon 承载；守卫内 LanManager 为门面）
      stop: async () => {
        if (deps && deps.supervisor && deps.supervisor._stopping) return { ok: true, already: true, reason: 'guard-shutdown 不停 lan' };
        try { lan.shutdown(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
      },
      status: () => lan.status ? lan.status() : null,
    });
    mgr.register(llc);
  }

  // 3. 实例管理：作为聚合生命周期单元注册，单个实例的启停由实例管理模块内部负责，
  //    本管理器只提供整体聚合视图。
  if (instances) {
    const ilc = new ManagedLifecycle({
      id: 'instances',
      kind: 'instances',
      name: '实例管理',
      // 聚合单元无全局进程：声明不可启停，避免「返回 ok 但无动作」的假成功；
      // 单个实例的启停走 /instances/{start|stop}。
      startable: false,
      guardable: false,
      logger,
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
      // detail 用实例集真实统计；phase/healthy 视图由守卫 _syncInstancesLifecycleView 每心跳刷新。
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

  // 4. DeepSeek Harness（主 DSH）——守卫监管的核心对象
  if (supervisor) {
    // guardian 不写死：守护开关属域 A（持久化 dsh-main.json，默认关，用户面板控制）。
    // 注册时从 supervisor 读当前值，之后经 _syncDshLifecycleView 从域 A 持续同步——
    // B 平面不持有独立守护策略（与沙箱同语义）。
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
    // DSH 的生命周期由守卫自身 tick 监管（唯一监管权）；本 dsh 项只是视图镜像——
    // 注册时同步一次守卫当前 desired/phase，之后靠 _syncDshLifecycleView 刷新。
    if (supervisor.desired === 'running') dsh.wantRunning();
    const ph = String(supervisor.phase || '');
    if (ph === 'RUNNING') { dsh._setPhase('running'); dsh.healthy = true; dsh.startedAt = dsh.startedAt || new Date().toISOString(); }
    else if (ph === 'STARTING' || ph === 'RESTARTING' || ph === 'BACKOFF') { dsh._setPhase('starting'); }
    dsh._monitoring = true; // DSH 恒纳管：对 desired=running 的 DSH 负责拉起本就是守卫 tick 职责
  }

  // 5. 插件管理（插件生命周期聚合）
  if (pluginManager) {
    const plc = new ManagedLifecycle({
      id: 'plugins',
      kind: 'plugins',
      name: '插件管理',
      ...capsOf('plugin'), // MANAGED_KINDS.plugin：startable=false / guardable=false（聚合视图）
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
