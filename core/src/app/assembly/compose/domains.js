'use strict';

const path = require('node:path');
const os = require('node:os');
const { RouterService } = require('../../../domains/router/index');
const { InstanceManager } = require('../../../domains/instance/index');
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
const ports = require('../../../platform/service/ports').shared;

function composeDomains(host) {
    const swDir = path.dirname(host.config.stateFile);
    
    try { ports.configureFile(path.join(path.dirname(host.config.stateFile), 'ports.json')); } catch (e) { host.logger.warn && host.logger.warn('ports configure: ' + e.message); }
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
