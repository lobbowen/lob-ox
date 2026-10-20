'use strict';

const path = require('node:path');
const os = require('node:os');
const { RouterService } = require('../../../domains/router/index');
const { InstanceManager } = require('../../../domains/instance/index');
// R8-agent：agent 管理域。DSH 是第一个被它管理的产品，域不绑定 DSH。
// 与 InstanceManager 并存是迁移期状态：前者管「沙箱实例」这一种形态的进程编排，
// 后者管「agent 生命周期」这一等概念。二者职责不同，不是重复。
const { AgentManager } = require('../../../domains/agent/index');
const { THROTTLE_DEFAULTS } = require('../../../domains/instance/state-machine');
const { PluginMarket } = require('../../../domains/plugin/market');
const { PluginManager } = require('../../../domains/plugin');
const { guardVersion } = require('../../../platform/service/version');
const { Lifecycle } = require('../../../app/self/lifecycle');
const { Health } = require('../../../app/self/health');
const { HostService } = require('../../../app/settings/autostart');
// R8-agent：原生 DSH 管理改走 agent 域（NativeAgentAdapter 只做形状翻译）。
const { NativeAgentAdapter } = require('../../../domains/agent/native-adapter');
const { BeatScheduler } = require('../../../app/control/synchrony');
const { LifecycleManager } = require('../../../app/control/manager');
const { ManagedLifecycle } = require('../../../app/control/entry');
const ports = require('../../../platform/service/ports').shared;
const { DSH_PRODUCT } = require('../../../domains/agent/model');

function composeDomains(host) {
    const swDir = path.dirname(host.config.stateFile);
    // R2：BeatScheduler 提前到装配期创建。原设计 RouterService 的构造参数就要
    // beatScheduler（第 26 行），但它此前在 assembly/bootstrap.js 的 _bootstrap 里
    // 才创建——compose 阶段拿到的是 undefined。现在提前创建，装配期就能注册
    // beat 与 afterTick，bootstrap 只负责 start。
    if (!host._beatScheduler) {
      host._beatScheduler = new BeatScheduler({ logger: host.logger, intervalMs: host.config.tickIntervalMs || 5000 });
    }
    try { ports.configureFile(path.join(path.dirname(host.config.stateFile), 'ports.json'), { siblingFiles: [path.join(path.dirname(host.config.stateFile), 'ports-router.json'), path.join(path.dirname(host.config.stateFile), 'ports-lan.json')] }); } catch (e) { host.logger.warn && host.logger.warn('ports configure: ' + e.message); }
    host.router = new RouterService({
      config: host.config,
      beatScheduler: host._beatScheduler, tickMs: host.config.tickIntervalMs || 5000,
      providerFile: path.join(swDir, 'providers.json'),
      usageTotalsFile: path.join(swDir, 'router-usage-totals.json'),
      logger: host.logger,
      events: host.events,
      dist: host.dist,
      tasks: host.tasks,
    });
    try { if (host.config.portPools) ports.configurePools(host.config.portPools); } catch (e) { host.logger.warn && host.logger.warn('ports pools configure: ' + (e && e.message)); }
    host._bindNativeDshCommand();
    // agent 管理域先构造：InstanceManager 与 nativeAgent 都要引用它。
    host.agents = new AgentManager({
      root: path.join(path.dirname(host.config.stateFile), 'agents'),
      logger: host.logger,
      events: host.events,
      dist: host.dist,
      tasks: host.tasks,
      service: host.service || null,
      tokens: host.tokenService,
      resstats: host.resstats || null,
    });
    host.instances = new InstanceManager({
      dir: path.dirname(host.config.stateFile),
      logger: host.logger,
      events: host.events,
      dist: host.dist,
      tasks: host.tasks,
      tokenService: host.tokenService,
      dshBin: host.config.command && host.config.command[1] ? host.config.command[1] : DSH_PRODUCT.binName,

      throttle: THROTTLE_DEFAULTS,
      // 沙箱实例的 DSH 安装/升级委托 agent 域——不为同一件事维护两套实现。
      agents: host.agents,
    });
    host.instances.load();
    host._migrateMainRecord();
    // R8-进程管理：ManagedRegistry（内核的受管对象表）已删除。
    // 它自己有 ports 管理、相位集合、持久化文件，与壳的 ProcessManager 职责完全重叠；
    // 且全仓零 register() 调用（registerAdapter 注册了回调但从无条目），
    // 那张表从来就是空的。沙箱实例改由 instance/lifecycle.js 直接
    // pmClient.register 上报到壳的进程表（带真实 spawn_cmd，壳能自愈它）。
    {
      // R2：BeatScheduler.afterTick 显式注册（注册列表是单一事实源）。
      // 注：原 'govern-sweep' 注册已随配额逻辑整段移除（按「共享系统资源」决策）。
      // 注意此处只注册，不启动 scheduler（启动在 assembly/bootstrap.js）。
      if (host._beatScheduler && typeof host._beatScheduler.afterTick === 'function') {
        // 端口残留登记与异主 daemon 检测：入口是 host.audit.orphan()
        // （app/audit/collaborator.js 的 createOrphanScan）。节流在其内部（5 分钟）。
        host._beatScheduler.afterTick('orphan-audit', () => host.audit.orphan());
        // D.6-P0-10：hub.sync() 整条多源事件聚合链路此前全仓零调用点——
        // _syncGuard/_syncDaemon/_saveWatermark 只被 sync() 调用，而 sync() 无人驱动。
        // 装配链是完整的（enableHub/attachHub/eventHub 都在），缺的就是这一处驱动。
        // 后果是 router-daemon 与 lan-daemon 的事件永不入聚合流、watermark 恒为初值，
        // 而「多源事件聚合」这个特性在代码结构、注释、UI 标签里都假定存在。
        // sync 内部自带节流（_tickSeq % 6 === 1 才同步 daemon），且由 beat 驱动有超时保护。
        host._beatScheduler.afterTick('event-hub-sync', () => {
          try {
            const hub = host.eventHub;
            if (hub && typeof hub.sync === 'function') return hub.sync();
          } catch (e) {
            host.logger && host.logger.warn && host.logger.warn('eventHub.sync: ' + ((e && e.message) || e));
          }
        });
        // E-1：沙箱实例监督此前**全仓零调用点**。lifecycle.supervise() 是完整的
        // （相位上报 + 状态机推进 + 资源采样），却没有任何东西驱动它——而壳的
        // heal_candidates 只捞「desired=running 且 phase=failed」的条目，内核不发
        // 相位壳就永远看不到沙箱的中间态。后果是沙箱自愈从未生效：崩了没人报 failed，
        // 壳也就无从重拉，而 UI / 契约表 / 注释都假定它在工作。
        // 与上方 event-hub-sync 同族（装配链完整、缺一处驱动），故用同一范式接上。
        // 节流在 lifecycle 内部（probe 自带平台探测成本），此处只做「遍历全部实例」。
        host._beatScheduler.afterTick('sandbox-supervise', () => {
          try {
            const mgr = host.instances;
            if (!mgr || typeof mgr.all !== 'function') return;
            for (const inst of mgr.all()) {
              if (!inst || inst.kind === 'native') continue;
              try { mgr.supervise(inst.id); } catch (e) {
                host.logger && host.logger.warn && host.logger.warn('supervise ' + inst.id + ': ' + ((e && e.message) || e));
              }
            }
          } catch (e) {
            host.logger && host.logger.warn && host.logger.warn('sandbox-supervise: ' + ((e && e.message) || e));
          }
        });
      }
    }
    host._lan = null;
    host.pluginMarket = new PluginMarket({
      stateFile: host.config.stateFile,
      logger: host.logger,
    });
    host.pluginManager = new PluginManager({
      dshBin: host.config.command && host.config.command[1] ? host.config.command[1] : DSH_PRODUCT.binName,
      profileName: host.config.pluginsProfileName || 'web',
      profileDir: path.join(os.homedir(), '.dsh', 'profiles', host.config.pluginsProfileName || 'web'),
      overlayFile: path.join(path.dirname(host.config.stateFile), 'plugin-states.patch.yml'),
      dshPort: host.config.targetPort,
      instances: host.instances,
      exitIntended: () => host._exitIntended(),
      tasks: host.tasks,
      logger: host.logger,
      events: host.events,
      dist: host.dist,
      onNativeRestart: () => {
        try { return host.requestRestart(); }
        catch (e) { host.logger.warn && host.logger.warn('plugin change → native restart: ' + e.message); return { ok: false, error: e.message }; }
      },
    });
    host.guardVersion = guardVersion();
    host.lifecycle = new Lifecycle();
    host.lifecycleManager = new LifecycleManager({ logger: host.logger, events: host.events });
    // 把 DSH 主实例注册进 lifecycleManager —— 这是 `register()` 在全仓的**第一个**调用点。
    //
    // 为什么必须：`manager.js` 的 start/stop/restart 全套 API 与 `/lifecycle/dsh/*` 路由
    // （api/domains/lifecycle.js:46 已为 id === 'dsh' 写好三个 action 分支）都等这一行，
    // 而它从来没人写 ⇒ registrations 表恒空 ⇒ `/lifecycle/dsh/start` 恒返
    // 「未注册模块: dsh」（manager.js:30）。而 manager.js:32/43 早已为 dsh 写好
    // `if (id !== 'dsh')` 的特殊分支 ⇒ 代码在等，缺的是注册。
    //
    // 为什么这是破环的唯一入口：内核 desired=stopped ⇒ 不认领（_adopt 要 portUp）
    // ⇒ 不 register ⇒ 壳侧没有 'dsh-main' 行 ⇒ setDesired('dsh-main') 被静默丢弃
    // ⇒ desired 回不到 running。而 `lobox start` 正是要走这条路。
    //
    // 为什么用惰性闭包（而不是直接传 host.startProcess）：装配顺序上 main 域的动作后挂，
    // 直接取会得 undefined。**而闭包还必须解析到 `host.main.startProcess` 而非
    // `host.startProcess`**——collaborators.js:32 的映射是 `startProcess: '_startProcess'`，
    // 由 installThin（facets.js:86，装配后期）挂到 host 上；本处注册在装配早期，首次调用时
    // `host.startProcess` 可能还没挂上。
    // 范式取自 collaborators.js:107 的 tick（同一坑的标准解）：
    //   `if (host.main && typeof host.main.converge === 'function') host.main.converge()`
    // 真机实证（1.0.50/0.0.34）：第一版写 `() => host.startProcess()` ⇒ 409
    // "host.startProcess is not a function"——路由通了、模块注册了、闭包取错了对象。
    // ⇒ 惰性只解决「什么时候取」，不解决「从哪个对象取」。
    try {
      host.lifecycleManager.register(new ManagedLifecycle({
        id: 'dsh',
        kind: 'dsh',
        name: 'DSH 主实例',
        logger: host.logger,
        events: host.events,
        start: () => {
          if (host.main && typeof host.main.startProcess === 'function') return host.main.startProcess();
          throw new Error('host.main.startProcess 不可用（装配未完成？）');
        },
        stop: (reason) => {
          if (host.main && typeof host.main.stopProcess === 'function') return host.main.stopProcess(reason || 'user-stop');
          throw new Error('host.main.stopProcess 不可用（装配未完成？）');
        },
        restart: () => {
          if (host.main && typeof host.main.beginRestart === 'function') return host.main.beginRestart('user-restart', { manual: true });
          throw new Error('host.main.beginRestart 不可用（装配未完成？）');
        },
        status: () => ({
          phase: host._mPhase ? host._mPhase() : null,
          desired: host._mDesired ? host._mDesired() : null,
          pid: host._mChild ? (host._mChild() ? host._mChild().pid : host._mAdoptPid()) : null,
          adopted: host._mAdopted ? host._mAdopted() : null,
          observedOnly: host._mObservedOnly ? host._mObservedOnly() : null,
        }),
      }));
    } catch (e) {
      try { host.logger && host.logger.warn && host.logger.warn('lifecycle register dsh 失败: ' + ((e && e.message) || e)); } catch {}
    }
    host.health = new Health(host.lifecycle);
    host.hostService = new HostService({ logger: host.logger, events: host.events });
    host.api = null;
    host.notifyEnabled = host.config.notifyEnabled !== false;
    host.loadState();
    // R8-agent：nativeAgent 现由 agent 域适配器提供。
    // hooks 原样透传——停/拉/期望态判定本来就是壳的职责，agent 域不越界。
    host.nativeAgent = new NativeAgentAdapter({
      agents: host.agents,
      config: host.config,
      dist: host.dist,
      events: host.events,
      logger: host.logger,
      stateDir: path.dirname(host.config.stateFile),
      tasks: host.tasks,
      hooks: {
        isDshActive: () => ['STARTING', 'RUNNING'].includes(host._mPhase()),
        desiredRunning: () => host._mDesired() === 'running',
        verifyDeadlineMs: () => Math.max(2 * host.config.startsecs * 1000, 120000),
        notify: (t, b) => host.notify(t, b),
        stopForUpgrade: async () => {
          const want = host._mDesired();
          if (want !== 'stopped') host.setDesired('stopped');
          host.stopProcess('upgrade-stop');
          const deadline = Date.now() + Math.max(2 * host.config.startsecs * 1000, 120000);
          while (Date.now() < deadline) {
            const child = host._mChild();
            const alive = !!child && child.exitCode === null;
            if (!alive) return { ok: true, stopped: true };
            await new Promise((r) => setTimeout(r, 250));
          }
          return { ok: false, error: 'upgrade-stop-timeout' };
        },
        resumeAfterUpgrade: async () => {
          if (host._mDesired() !== 'running') host.setDesired('running');
          await host.startProcess();
          return { ok: true };
        },
      },
    });
    host._registerFixedPorts();
}

module.exports = { composeDomains };
