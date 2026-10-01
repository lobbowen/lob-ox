'use strict';

const path = require('node:path');
const platform = require('../../../platform/os/index');
const { normalize } = require('../../../platform/service/config');
const { extension: domainConfigExtension } = require('../../../app/settings/domain-config');
const logcore = require('../../../platform/service/log/logcore');
const { DshTokenService } = require('../../../platform/service/token');
const { EnvCatalog } = require('../../../platform/service/env-catalog');
const npm = require('../../native/npm');

const FORM_NPM_ROOT_TIMEOUT_MS = 4000;
const { DistributionManager } = require('../../../platform/distribution/index');
const shellDomain = require('../../../domains/shell/index');
const { TaskRegistry } = require('../../../platform/service/tasks');
const { IntentLedger } = require('../../../app/state/intents');
require('../log-sources');
const { TOKEN_FILE_NAME } = require('../../../app/settings/token-kinds');

function composeCore(host, rawConfig, configPath) {
    host.config = normalize(rawConfig, domainConfigExtension());
    host.configPath = typeof configPath === 'string' ? configPath : null;
    platform.environment.bind({ preference: () => (host.config && host.config.externalBrowser) || null });
    platform.environment.registerSection('runtime', {
      label: '运行时（Node/npm/git/镜像源/全局前缀）',
      probe: async () => {
        const cat = await new EnvCatalog(host.config).probeAsync();
        const m = host.nativeManager;
        const [reg, prefix] = await Promise.all([
          m && m.dist && typeof m.dist.registryInfo === 'function'
            ? Promise.resolve(m.dist.registryInfo()).catch(() => null) : Promise.resolve(null),
          m ? npm.resolveNpmRoot(m, { timeoutMs: FORM_NPM_ROOT_TIMEOUT_MS }).catch(() => null) : Promise.resolve(null),
        ]);
        return {
          node: cat.node, npm: cat.npm, git: cat.git,
          registry: reg ? {
            origin: reg.origin || null, mode: reg.mode || null, source: reg.source || null,
            manualOrigin: reg.manualOrigin || null,
            candidates: (reg.registries || []).map((r) => ({
              base: r.base, reachable: r.reachable === undefined ? null : r.reachable,
              latencyMs: r.latencyMs === undefined ? null : r.latencyMs, error: r.error || null,
            })),
          } : null,
          prefix: prefix || null,
        };
      },
    });
    platform.environment.registerSection('dsh', {
      label: 'DSH 本体与内核更新',
      probe: async () => {
        const cat = new EnvCatalog(host.config);
        const d = typeof host.dshenvStatus === 'function' ? host.dshenvStatus() : null;
        if (!d) return null;
        return {
          dsh: cat.dshEntry(d.binOk, d.installed, d.bin),
          selfUpdate: cat.selfUpdateEntry(),
          managed: d.managed === true, phase: d.phase || null,
        };
      },
    });
    platform.environment.registerSection('startup', {
      label: '启动既成事实（守卫这一拍跑过什么）',
      probe: () => {
        const s = host._startupFacts;
        if (!s) return null;
        return {
          bootAt: s.bootAt, envDelayMs: s.envDelayMs,
          routerAutostart: s.routerAutostart, routerMode: s.routerMode,
          updateCheck: s.updateCheck, shellWatchdog: s.shellWatchdog, lastRefresh: s.lastRefresh,
        };
      },
    });
        // 数据目录保护用目录级 ACL（NTFS 继承 ACE 覆盖子项；逐个文件 icacls 会写放大）：Unix chmod 0700 / Windows icacls 去继承，目录含 apiAccessKey 等凭据。
    host._fileProtectStatus = null;
    try {
      const fp = platform.fileProtect;
      const swDir = path.dirname(host.config.stateFile);
      const targets = new Set([swDir]);
      try { targets.add(platform.supervisorDir()); } catch {}
      const results = [];
      for (const d of targets) {
        const pr = fp.ensurePrivateDir(d);
        results.push({ dir: d, ...pr });
      }
      host._fileProtectStatus = results;
      const bad = results.filter((r) => !r.ok);
      if (bad.length) { try { console.warn('[supervisor] 数据目录保护未完全成功: ' + bad.map((b) => b.dir + '(' + b.mode + ':' + (b.reason || '') + ')').join('; ')); } catch {} }
    } catch (e) { try { console.warn('[supervisor] 数据目录保护异常: ' + (e && e.message)); } catch {} }
    host._mSetChild(null);
    host._mSetAdoptPid(null);
    host._mSetPhase('STOPPED');
    host._mSetDesired('running');
    host._mSetRestartCount(0);
    host._mSetStartupFailWindowStart(null);
    host._mSetStartupFailCount(0);
    host._mSetRestartAt(null);
    host._mSetStartDeadline(null);
    host._mSetLastFailure(null);
    host._mSetLastRestartAt(null);
    host._mSetAdopted(false);
    host._mSetObservedOnly(false);
    host._mSetSpawnBlockedUntil(null);
    host._mSetMissingNotified(false);
    host.manualRestart = false;
    host._ticking = false;
    host.intents = new IntentLedger();
    host._stopping = false;
    host._sessionState = 'starting';
    host._crashHalted = false;
    host._shellHalted = false;
    host._upgradeHold = false;
    host._upgradeHoldSince = null;
    host._timer = null;
    host._heartbeatBusy = false;
    host._killTimer = null;
    host._adoptKillTimer = null;
    host._initialCheckTimer = null;
    host._upgradeTimer = null;
    host._shellWatchdogTimer = null;
    host._lastOccupiedWarn = 0;
    host._lastMainPortRederive = 0;
    host._lastPortUp = false;
    host._lastOrphanAuditAt = 0;
    host._lastOrphanKey = null;
    host._lastOrphanAt = 0;
    host._actWindow = false;
    host._mainTickActs = null;
    host._portActivesCache = null;
    host._lastLanStateJson = null;
    host._routerFacade = null;
    host._lc = null;
    host._dshMainLive = null;
    host._shadowSeq = 0;
    host._shadowConsistentBeats = 0;
    host._shadowDiffBeats = 0;
    host._shadowLast = null;
    host._shadowLoggedSeq = 0;
    const logCore = logcore.init({
      process: 'guard',
      logFile: host.config.supervisorLogFile,
      eventFile: host.config.logFile,
      dshLogFile: host.config.dshLogFile,
      upgradeLogFile: host.config.upgradeLogFile,
      logLevel: host.config.logLevel,
      logMaxBytes: host.config.logMaxBytes,
      eventsMaxBytes: host.config.eventsMaxBytes,
      enableHub: true,
      stateDir: path.dirname(host.config.stateFile),
      aggBase: path.basename(host.config.stateFile || 'state.json', '.json'),
      ctlPorts: { router: Number(host.config.routerCtlPort) || 43107, lan: Number(host.config.lanCtlPort) || 43108 },
      daemonLogs: {
        router: path.join(path.dirname(host.config.stateFile), 'log', 'router-daemon.log'),
        lan: path.join(path.dirname(host.config.stateFile), 'log', 'lan-daemon.log'),
      },
    });
    host.events = logCore.events;
    host.logger = logCore.logger;
    host.dshWriter = logCore.dshWriter;
    host.eventHub = logCore.reader || logCore.hub;
    host.tokenService = new DshTokenService({ logger: host.logger, events: host.events });
    host.tokenService.attach('main', { file: path.join(path.dirname(host.config.stateFile), TOKEN_FILE_NAME) });
    host.tokenService.onChange((id, token) => {
      if (host.lanDaemonEnabled()) { try { host._syncLanState(); } catch {} return; }
      if (host.lan) { try { host.lan.applyToken(id, token); } catch (e) { host.logger.warn && host.logger.warn('lan applyToken(' + id + '): ' + e.message); } }
    });
    const swDir = path.dirname(host.config.stateFile);
    host.dist = new DistributionManager({
      registries: (host.config.registries && host.config.registries.length) ? host.config.registries : ['https://registry.npmjs.org'],
      registryFile: path.join(swDir, 'registry.json'),
      registryChoiceFile: path.join(swDir, 'registry-choice.json'),
      events: host.events,
      logger: host.logger,
      canary: host.config.canary === true,
    });
    host.shellDomain = shellDomain;
    host.tasks = new TaskRegistry({
      stateDir: swDir,
      logger: host.logger,
      events: host.events,
    });
}

module.exports = { composeCore };
