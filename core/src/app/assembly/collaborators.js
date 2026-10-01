'use strict';

const { createStateStore } = require('../state/collaborator');
const { createSession } = require('../session/machine');
const { createControlPlane } = require('../control/collaborator');
const { createCtl } = require('../ctl/collaborator');
const { createOrphanScan } = require('../audit/collaborator');
const { ENTRY_FIELDS, PROC_FIELDS } = require('../state/field-tables');
const { aliases: CONFIG_ALIASES } = require('../settings/domain-config');

const THIN_SPEC = {
  ctl: {
    call: '_ctlCall', lanCall: '_lanCtlCall',
    lanPort: '_lanCtlPort', routerPort: '_routerCtlPort', routerFacade: '_makeRouterFacade',
  },
  daemons: {
    enabled: 'lanDaemonEnabled',
    routerActive: '_routerDaemonActive', lanActive: '_lanDaemonActive',
    lifecycle: '_daemonLifecycle',
    disableRouterPersist: '_disableRouterPersist',
    ensureLanRuntime: '_ensureLanRuntime', ensureRouterRuntime: '_ensureRouterRuntime',
    syncLanState: '_syncLanState', warnOccupied: '_warnOccupied',
    managed: '_daemonManaged', lanManaged: '_lanManaged',
    writeLanLock: '_writeLanLock', clearLanLock: '_clearLanLock',
    writeRouterDaemonLock: '_writeRouterDaemonLock', clearRouterDaemonLock: '_clearRouterDaemonLock',
  },
  main: {
    converge: '_dshConverge',
    decideAction: '_decideMainAction', stateSnapshot: '_mainStateSnapshot',
    applyHealthCheck: '_applyHealthCheck', bumpCrashWindow: '_bumpCrashWindow',
    adopt: '_adopt', adoptObserved: '_adoptObserved',
    applyPort: '_applyMainPort', beginRestart: '_beginRestart', enterRunning: '_enterRunning',
    findManagedPort: '_findManagedDshPort',
    startProcess: '_startProcess', stopProcess: 'stopProcess',
    isManagedProcess: '_isManagedProcess', killAdopted: '_killAdopted', killSequence: '_killSequence',
    actNote: '_actNote', shadowHeartbeat: '_shadowHeartbeatBeat', shadowTickNote: '_shadowTickNote',
  },
  views: {
    dshMain: 'dshMainView',
    routerDaemonActive: 'routerDaemonActive', routerStatus: 'routerStatus',
    status: 'statusSummary',
  },
  ui: { notify: 'notify' },
};
const THIN_NAMES = Object.keys(THIN_SPEC);

function assertCollaboratorTargets(host) {
  const missing = [];
  for (const name of THIN_NAMES) {
    for (const [pub, src] of Object.entries(THIN_SPEC[name])) {
      if (typeof host[src] !== 'function') missing.push(name + '.' + pub + ' -> ' + src);
    }
  }
  if (missing.length) throw new Error('app/assembly/collaborators: 接口表指向缺失方法: ' + missing.join(', '));
}

function installFieldHelpers(host, state) {
  for (const [suf, field] of ENTRY_FIELDS) {
    host['_m' + suf] = function () { return state.field(field); };
    host['_mSet' + suf] = function (v) { state.field(field, v); return host; };
  }
  for (const [suf, field, isBool] of PROC_FIELDS) {
    host['_m' + suf] = function () { return state.procField(field); };
    host['_mSet' + suf] = function (v) { state.procField(field, isBool ? v === true : v); return host; };
  }
}

function installState(host) {
  const state = createStateStore({
    getConfig: () => host.config, getConfigPath: () => host.configPath,
    getConfigAliases: () => CONFIG_ALIASES,
    getLogger: () => host.logger, getEvents: () => host.events,
    getManagedObjects: () => host.managedObjects, getInstances: () => host.instances,
    getViews: () => host.views, getIntents: () => host.intents,
    getCrashHalted: () => host._crashHalted, setCrashHalted: (v) => { host._crashHalted = v; },
    getManualRestart: () => host.manualRestart, setManualRestart: (v) => { host.manualRestart = v; },
    getHold: () => host._upgradeHold, setHold: (v) => { host._upgradeHold = v; },
    getSince: () => host._upgradeHoldSince, setSince: (v) => { host._upgradeHoldSince = v; },
    getShellHalted: () => host._shellHalted, setShellHalted: (v) => { host._shellHalted = v; },
    stopProcess: (why) => host.stopProcess(why), tick: () => host.tick(),
  });
  host.state = state;

  host._legacyToEntryPhase = (ph) => state.legacyToEntryPhase(ph);
  host._entryToLegacyPhase = (ph) => state.entryToLegacyPhase(ph);
  host._mPhase = () => state.phase();
  host._mSetPhase = (u) => { state.setPhase(u); return host; };
  host._mGuardian = () => state.guardian();
  host.mainGuardian = () => state.mainGuardian();
  host._mDesired = () => state.desired();
  host._mSetDesired = (v) => { state.setDesired(v); return host; };
  host._dshEntry = () => state.dshEntry();
  host._persistCrashField = () => state.persistCrashField();
  host._mStore = () => state.store();
  host._mField = function (name, v) {
    return arguments.length >= 2 ? state.field(name, v) : state.field(name);
  };
  host._mProcField = function (name, v) {
    return arguments.length >= 2 ? state.procField(name, v) : state.procField(name);
  };
  host._dshMainFile = () => state.mainMetaFile();
  host._registryFileName = () => state.registryFileName();
  host._readDshMain = () => state.readMainMeta();
  host._readDshMainFile = () => state.readMainMetaFile();
  host.writeState = (force) => state.write(force);
  host.loadState = () => state.loadState();
  host._migrateMainRecord = () => state.migrateMainRecord();
  host.setDesired = (v) => state.setDesiredPublic(v);
  host.requestRestart = () => state.requestRestart();
  host.persistConfigPatch = (patch) => state.persistConfigPatch(patch);
  host._enterUpgradeHold = () => state.enterUpgradeHold();
  host._enterUpgradeHoldAsync = () => state.enterUpgradeHoldAsync();
  host._exitUpgradeHold = (explicit) => state.exitUpgradeHold(explicit);
  installFieldHelpers(host, state);
  for (const name of Object.keys(state.accessors)) Object.defineProperty(host, name, state.accessors[name]);
}

function installSession(host) {
  const session = createSession({
    events: () => host.events,
    desired: () => host.state.desired(),
    crashHalted: () => host._crashHalted,
  });
  host.session = session;
  host.sessionState = () => session.state();
  host._setSessionState = (s) => { session.setState(s); };
  host._sessionHalting = () => session.halting();
  host._exitIntended = () => !!(host._stopping || session.halting());
  host._shellExitIntended = () => !!(host._exitIntended() || host._shellHalted);
  host._shouldRun = () => session.shouldRun();
  Object.defineProperty(host, '_sessionState', {
    get: () => session.state(),
    set: (s) => { session.setState(s); },
  });
}

function installControl(host) {
  const control = createControlPlane({
    getLifecycleManager: () => host.lifecycleManager,
    getState: () => host.state,
    getManagedObjects: () => host.managedObjects,
    getInstances: () => host.instances,
    getConfig: () => host.config,
    getCtl: () => host.ctl,
    getDaemons: () => host.daemons,
    getLogger: () => host.logger,
  });
  host.control = control;
  host._syncDshLifecycleView = () => control.syncDshView();
  host._syncRouterLifecycleView = (o) => control.syncRouterView(o);
  host._syncInstancesLifecycleView = () => control.syncInstancesView();
  host._managedSandboxSpec = (inst) => control.sandboxSpec(inst);
  host._upsertManaged = (spec) => control.upsert(spec);
  host._unregisterManaged = (id) => control.unregister(id);
  host._managedMainSpec = () => control.mainSpec();
  host._syncManagedRegistry = () => control.syncManagedRegistry();
}

function installThin(host) {
  for (const name of THIN_NAMES) {
    const obj = {};
    for (const [pub, src] of Object.entries(THIN_SPEC[name])) {
      obj[pub] = function (...args) { return host[src](...args); };
    }
    host[name] = obj;
  }
}

function installAuditFactory(host) {
  host.audit = createOrphanScan({
    getConfig: () => host.config,
    getLogger: () => host.logger,
    getEvents: () => host.events,
    getInstances: () => host.instances,
    getManagedObjects: () => host.managedObjects,
    getCtl: () => host.ctl,
    getDaemons: () => host.daemons,
    getStopping: () => host._stopping,
    getLastKey: () => host._lastOrphanKey,
    setLastKey: (v) => { host._lastOrphanKey = v; },
    getLastAt: () => host._lastOrphanAt,
    setLastAt: (v) => { host._lastOrphanAt = v; },
  });
}

function installCtlFactory(host) {
  host.ctl = createCtl({
    getConfig: () => host.config,
    getCtlCall: () => host._ctlCall.bind(host),
    getLanCtlCall: () => host._lanCtlCall.bind(host),
    getLanCtlPort: () => host._lanCtlPort.bind(host),
    getRouterCtlPort: () => host._routerCtlPort.bind(host),
    getRouterFacade: () => host._makeRouterFacade.bind(host),
  });
}

function installCollaborators(host, options) {
  installState(host);
  installSession(host);
  installControl(host);
  installThin(host);
  installCtlFactory(host);
  installAuditFactory(host);
  if (options && options.validate) assertCollaboratorTargets(host);
  return host;
}

module.exports = { THIN_SPEC, assertCollaboratorTargets, installCollaborators };
