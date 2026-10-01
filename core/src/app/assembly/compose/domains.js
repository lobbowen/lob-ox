'use strict';

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
    // 端口账本必须在 RouterService 构造前指向 stateFile 派生文件（注册表进程级单例、最后一个 configureFile 生效；见 router/index.js:43-45）。
    try { ports.configureFile(path.join(path.dirname(host.config.stateFile), 'ports.json')); } catch (e) { host.logger.warn && host.logger.warn('ports configure: ' + e.message); }
    host.router = new RouterService({
      config: host.config,
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
    });
    host.instances.load();
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
        host.managedObjects.registerAdapter('router-daemon', { supervise: () => host._daemonSuperviseOnce('router'), tickEvery: 6, derivePhase: true });
        host.managedObjects.registerAdapter('lan-daemon', { supervise: () => host._daemonSuperviseOnce('lan'), tickEvery: 6, derivePhase: true });
        host.managedObjects.registerAdapter('dsh', { supervise: () => host._dshSuperviseOnce(), tickEvery: 1 });
        host.managedObjects.registerAdapter('sandbox-instance', { supervise: (entry) => host._sandboxSuperviseOnce(entry), tickEvery: 1 });
      }
      if (host.managedObjects) host.managedObjects.onBeatDone = () => host.instances.governSweep();
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
        stopForUpgrade: () => host._enterUpgradeHoldAsync(),
        resumeAfterUpgrade: () => host._exitUpgradeHold(true),
        verifyDeadlineMs: () => Math.max(2 * host.config.startsecs * 1000, 120000),
        notify: (t, b) => host.notify(t, b),
      },
    });
    host._registerFixedPorts();
}

module.exports = { composeDomains };
