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
const { ManagedRegistry } = require('../../../app/control/registry');
const { guardVersion } = require('../../../platform/service/version');
const { Lifecycle } = require('../../../app/self/lifecycle');
const { Health } = require('../../../app/self/health');
const { HostService } = require('../../../app/settings/autostart');
const { NativeManager } = require('../../../app/native/installer');
const { LifecycleManager } = require('../../../app/control/manager');
const { BeatScheduler } = require('../../../app/control/synchrony');
const ports = require('../../../platform/service/ports').shared;

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
    host.instances = new InstanceManager({
      dir: path.dirname(host.config.stateFile),
      logger: host.logger,
      events: host.events,
      dist: host.dist,
      tasks: host.tasks,
      tokenService: host.tokenService,
      dshBin: host.config.command && host.config.command[1] ? host.config.command[1] : 'dsh',
      
      throttle: THROTTLE_DEFAULTS,
    });
    host.instances.load();
    // agent 管理域：与 instances 并存，先立起来不切换路由。
    // 现有 API 仍走 InstanceManager/NativeManager——切换是独立一步，
    // 混在同一提交里会让「域建好了」和「链路换了」无法分别验证。
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
    host._migrateMainRecord();
    try {
      host.managedObjects = new ManagedRegistry({
        file: path.join(path.dirname(host.config.stateFile), host._registryFileName()),
        logger: host.logger,
        events: host.events,
        ports: ports,
      });
      host._syncManagedRegistry();
      if (host.managedObjects && typeof host.managedObjects.registerAdapter === 'function') {
        host.managedObjects.registerAdapter('sandbox-instance', { supervise: (entry) => host._sandboxSuperviseOnce(entry), tickEvery: 1 });
      }
      // R2/D.11-P0-12：原先把 onBeatDone 赋给 host.managedObjects，但 ManagedRegistry
      // 根本没有这个属性也没有读取方，而 BeatScheduler 自己持有的 onBeatDone 字段
      // 无人赋值——结果是 governSweep 整套资源配额体系在生产中永不执行。
      // 改为 BeatScheduler.afterTick 显式注册：注册列表是单一事实源，
      // 「挂了但没人读」与「读了但没人挂」两种失效都不可能。
      // 注意此处只注册，不启动 scheduler（启动在 assembly/bootstrap.js）。
      if (host._beatScheduler && typeof host._beatScheduler.afterTick === 'function') {
        host._beatScheduler.afterTick('govern-sweep', () => {
          try { host.instances.governSweep(); } catch (e) {
            host.logger && host.logger.warn && host.logger.warn('governSweep: ' + ((e && e.message) || e));
          }
        });
        // 与 govern-sweep 同一根因的第三处空转：orphanAudit 全库无调用点。
        // 节流在 scheduler.js 的 orphanAudit 内部（5 分钟）。
        host._beatScheduler.afterTick('orphan-audit', () => host.orphanAudit());
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
      }
    } catch (e) { host.logger && host.logger.warn && host.logger.warn('managed registry init: ' + (e && e.message)); }
    host._lan = null;
    host.pluginMarket = new PluginMarket({
      stateFile: host.config.stateFile,
      logger: host.logger,
    });
    host.pluginManager = new PluginManager({
      dshBin: host.config.command && host.config.command[1] ? host.config.command[1] : 'dsh',
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
    host.health = new Health(host.lifecycle);
    host.hostService = new HostService({ logger: host.logger, events: host.events });
    host.api = null;
    host.notifyEnabled = host.config.notifyEnabled !== false;
    host.loadState();
    host.nativeManager = new NativeManager({
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
