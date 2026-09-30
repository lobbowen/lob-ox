'use strict';

// app/assembly/compose/domains.js —— 组装第二步：各业务域/基础设施域构造 + 固定端口登记。
// 域实现不在本文件；此处只负责构造顺序与 deps 注入。
// 持久化文件一律按 stateFile 派生：测试用自定义 stateFile 即天然隔离，不污染生产记录。

const path = require('node:path');
const os = require('node:os');
const { RouterService } = require('../../../domains/router/index');
const { InstanceManager } = require('../../../domains/instance/index');
const { PluginMarket } = require('../../../domains/plugin/market');
const { PluginManager } = require('../../../domains/plugin');
const { ManagedRegistry } = require('../../../app/control/registry');
const { guardVersion } = require('../../../platform/service/version');
const { Lifecycle } = require('../../../app/self/lifecycle');
const { Health } = require('../../../app/self/health');
const { HostService } = require('../../../app/settings/autostart');
const { NativeManager } = require('../../../app/native/installer');
const { LifecycleManager } = require('../../../app/control/manager');
const ports = require('../../../platform/service/ports').shared;

function composeDomains(host) {
    const swDir = path.dirname(host.config.stateFile);
    host.router = new RouterService({
      config: host.config,
      providerFile: path.join(swDir, 'providers.json'),
      usageTotalsFile: path.join(swDir, 'router-usage-totals.json'),
      logger: host.logger,
      events: host.events,
      dist: host.dist,
      tasks: host.tasks,
    });
    try { ports.configureFile(path.join(path.dirname(host.config.stateFile), 'ports.json')); } catch (e) { host.logger.warn && host.logger.warn('ports configure: ' + e.message); }
    // 端口池范围是配置项而非编译期常量：config.portPools 覆盖默认池。
    try { if (host.config.portPools) ports.configurePools(host.config.portPools); } catch (e) { host.logger.warn && host.logger.warn('ports pools configure: ' + (e && e.message)); }
    // 原生 DSH 检测 -> 绑定（必须先于任何消费者：InstanceManager/PluginManager/spawn）。
    host._bindNativeDshCommand();
    host.instances = new InstanceManager({
      dir: path.dirname(host.config.stateFile),
      logger: host.logger,
      events: host.events,
      dist: host.dist, // 沙箱实例的 npm 安装与 DSH 自升级共用全局镜像源（dist 为唯一通道）
      tasks: host.tasks,
      tokenService: host.tokenService, // 唯一令牌节点（实例侧只登记源 + 触发捕获，不持有/转发令牌）
      dshBin: host.config.command && host.config.command[1] ? host.config.command[1] : 'dsh',
    });
    host.instances.load();
    // 历史 instances.json 里的 main 记录：元数据迁入 dsh-main.json（守卫核心存储）后剔除。
    host._migrateMainRecord();
    // 管家声明目录：记录受管对象的应然 + 所有权；当前是影子目录，不驱动任何循环。
    try {
      // 文件名按 stateFile 派生（默认 managed-objects.json），避免同 TMP 目录多守卫实例互相污染
      host.managedObjects = new ManagedRegistry({
        file: path.join(path.dirname(host.config.stateFile), host._registryFileName()),
        logger: host.logger,
        events: host.events,
        ports: ports,
      });
      host._syncManagedRegistry();
      // daemon 监督 adapter：heartbeat 驱动；节流 6 拍~30s。
      if (host.managedObjects && typeof host.managedObjects.registerAdapter === 'function') {
        host.managedObjects.registerAdapter('router-daemon', { supervise: () => host._daemonSuperviseOnce('router'), tickEvery: 6, derivePhase: true });
        host.managedObjects.registerAdapter('lan-daemon', { supervise: () => host._daemonSuperviseOnce('lan'), tickEvery: 6, derivePhase: true });
        // main(dsh) adapter：heartbeat 把 main 实然写入目录（lastObserved），不驱动；
        // supervise 内做影子对比（纯计算+日志），实然与 tick 同源（monitor.probe -> lastProbeOk）。
        host.managedObjects.registerAdapter('dsh', { supervise: () => host._dshSuperviseOnce(), tickEvery: 1 });
        // sandbox-instance adapter：heartbeat 逐实例监督（InstanceManager.supervise 单实例收敛 +
        // 目录应然/相位同步）；域业务（CRUD/安装/装配/systemd/持久化）仍在 InstanceManager。
        host.managedObjects.registerAdapter('sandbox-instance', { supervise: (entry) => host._sandboxSuperviseOnce(entry), tickEvery: 1 });
      }
      // B2-6e：governor 全花名册 decide 与监督同源、每心跳拍恰好一次（拍末钩子），
      // 不再随逐实例 supervise 拍执行——N 个 RUNNING 实例把 decide 乘法放大的 O(N^2) 消失。
      if (host.managedObjects) host.managedObjects.onBeatDone = () => host.instances.governSweep();
    } catch (e) { host.logger && host.logger.warn && host.logger.warn('managed registry init: ' + (e && e.message)); }
    // relay 在 daemon 模式唯一由独立 lan-daemon 承载，守卫只在非 daemon 经 get lan() 惰性创建
    //   本地实例；两种模式同写 ports.json（B2-5 单源），漏网 new 不再分裂出第二本账，
    //   但本地/daemon 双载体仍会互相抢 relay 绑定，故按模式收敛创建点。
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
      // INV-S1 退出门谓词注入（E-3 单源）——插件变更生效重启路径
      //   持有裸 InstanceManager，必须同受退出意图约束。
      exitIntended: () => host._exitIntended(),
      tasks: host.tasks,
      logger: host.logger,
      events: host.events,
      dist: host.dist, // 插件安装/卸载与 DSH 自升级共用全局镜像源
      // 插件变更（卸载/启停）涉及原生目标时：统一走守卫生命周期重启（等价于面板重启按钮）
      onNativeRestart: () => {
        try { return host.requestRestart(); }
        catch (e) { host.logger.warn && host.logger.warn('plugin change → native restart: ' + e.message); return { ok: false, error: e.message }; }
      },
    });
    // 单一版本源（package.json）归 platform/service/version。
    host.guardVersion = guardVersion();
    // 守卫自身生命周期 + 健康 + 遥测 + 主机服务对接（infra：与实例生命周期完全分离）
    host.lifecycle = new Lifecycle();
    // 模块生命周期的唯一注册表：守卫持监测权，但模块各自独立启停，守卫重启不停被管模块。
    host.lifecycleManager = new LifecycleManager({ logger: host.logger, events: host.events });
    host.health = new Health(host.lifecycle);
    host.hostService = new HostService({ logger: host.logger, events: host.events });
    host.api = null;
    host.notifyEnabled = host.config.notifyEnabled !== false;
    host.loadState();
    // 原生 DSH 生命周期管理器：安装/卸载/版本检测/升级（原生 DSH 的唯一管理门面，单通道）
    host.nativeManager = new NativeManager({
      config: host.config,
      dist: host.dist,
      events: host.events,
      logger: host.logger,
      stateDir: path.dirname(host.config.stateFile),
      tasks: host.tasks,
      // 守卫生命周期钩子：升级需停/起 DSH 时回调
      hooks: {
        isDshActive: () => ['STARTING', 'RUNNING', 'RESTARTING', 'BACKOFF'].includes(host._mPhase()),
        desiredRunning: () => host._mDesired() === 'running',
        stopForUpgrade: () => host._enterUpgradeHoldAsync(),
        resumeAfterUpgrade: () => host._exitUpgradeHold(true),
        verifyDeadlineMs: () => Math.max(2 * host.config.startTimeoutMs, 120000),
        notify: (t, b) => host.notify(t, b),
      },
    });
    // 概念清分：原生 DSH 是主干，软件本体由 NativeManager 独立管理（/native/* + /lifecycle/dsh/*）；
    // 沙箱实例由 InstanceManager 管理（/instances/*）。原生不挂进沙箱实例出口，不注入任何句柄/委托。
    // 系统级端口登记：固定端口统一注册，冲突启动即 fail-fast，杜绝各子系统各管各的端口。
    host._registerFixedPorts();
}

module.exports = { composeDomains };
