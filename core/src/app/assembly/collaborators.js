'use strict';

// app/assembly/collaborators.js —— 具名协作方装配（真 ctor 注入）。
// state/session/control 由工厂构造并自持实现，host 只保留旧方法名兼容外壳，公共面（api/测试）不变；
// ctl/daemons/main/views/ui 由 THIN_SPEC 声明为薄委托，转发到 host 上的既有实现；audit 是真 ctor 工厂。

const { createStateStore } = require('../state/collaborator');
const { createSession } = require('../session/machine');
const { createControlPlane } = require('../control/collaborator');
const { createCtl } = require('../ctl/collaborator');
const { createOrphanScan } = require('../audit/collaborator');
const { ENTRY_FIELDS, PROC_FIELDS } = require('../state/field-tables');
// 换名别名字典的唯一声明处（与 config.normalize 同源，B2-4）：注入 state 供 persistConfigPatch 清理旧键。
const { aliases: CONFIG_ALIASES } = require('../settings/domain-config');

// 薄委托切面 -> { 协作方公开名: host 上的既有方法名 }
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

/** 装配期校验：薄委托接口表里每个公开名都指向 host 上真实存在的函数。 */
function assertCollaboratorTargets(host) {
  const missing = [];
  for (const name of THIN_NAMES) {
    for (const [pub, src] of Object.entries(THIN_SPEC[name])) {
      if (typeof host[src] !== 'function') missing.push(name + '.' + pub + ' -> ' + src);
    }
  }
  if (missing.length) throw new Error('app/assembly/collaborators: 接口表指向缺失方法: ' + missing.join(', '));
}

/** 字段 helper（_mXxx/_mSetXxx）兼容外壳：委托到 state 协作方。 */
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

/** 安装 State 协作方，并把旧方法名转发到它上面。 */
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
  // 兼容访问器（phase/desired/child/...）安装到 host 实例（非 prototype）。
  for (const name of Object.keys(state.accessors)) Object.defineProperty(host, name, state.accessors[name]);
}

/** 安装 Session 协作方 + 旧方法名/字段兼容外壳。 */
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
  // 意图轴单源谓词：「守卫/会话正在退出」= _stopping（守卫关停）或 session halting。
  //   一切自愈/拉起/收敛/补做入口都经本谓词门禁，禁止在调用点各自拼合子集（谓词漂移即门禁失效）。
  //   _shellHalted 不在此列：它是桌面壳域的持久退出意图（跨守卫重启），只否决壳看护；
  //   主 DSH 的恢复权威是 desired，混入会破坏恢复语义并在 headless 下永久死锁（见 _shellExitIntended）。
  host._exitIntended = () => !!(host._stopping || session.halting());
  // 桌面壳域退出判据：通用退出 或 持久 _shellHalted。仅供壳看护（bootstrap）使用。
  host._shellExitIntended = () => !!(host._exitIntended() || host._shellHalted);
  host._shouldRun = () => session.shouldRun();
  Object.defineProperty(host, '_sessionState', {
    get: () => session.state(),
    set: (s) => { session.setState(s); },
  });
}

/** 安装 Control 协作方 + 旧方法名兼容外壳。 */
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

/** 安装其余薄委托协作方（ctl/daemons/main/views/audit/ui）。 */
function installThin(host) {
  for (const name of THIN_NAMES) {
    const obj = {};
    for (const [pub, src] of Object.entries(THIN_SPEC[name])) {
      obj[pub] = function (...args) { return host[src](...args); };
    }
    host[name] = obj;
  }
}

/** 安装 audit 协作方（真 ctor 工厂）：host.audit.orphan() 直达工厂（唯一消费点 control/scheduler.js）。
 *  audit 不进 THIN_SPEC —— 它没有 host 侧既有实现可转发，12 项惰性 deps 也只在此声明一处。
 *  deps 全为惰性取值（装配期 host 尚未就绪），节流簿记仍落在 host._lastOrphanKey/_lastOrphanAt
 *  （与 compose/core.js 的初始化点同源）。 */
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

/** 安装 ctl 协作方（真 ctor 工厂）：公开键 = THIN_SPEC.ctl，覆盖 installThin 的转发器，
 *  使 host.ctl.* 与 host._* 走同一实现。宿主 getter 必须每次重取 + bind（不得固化实现）：
 *  测试会覆写 host._lanCtlCall 验证门面路径剔除令牌，固化后覆写面即失效。 */
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

/** 把协作方落到 host 实例（先真 ctor，后薄委托；validate 时校验薄委托目标存在）。 */
function installCollaborators(host, options) {
  installState(host);
  installSession(host);
  installControl(host);
  installThin(host);
  // 工厂化切面：必须在 installThin 之后（要覆盖 ctl 转发器）且 installState/Control 之后
  //   （domain-actions 经 state/views/lifecycleManager 取事实）。
  installCtlFactory(host);
  installAuditFactory(host);
  if (options && options.validate) assertCollaboratorTargets(host);
  return host;
}

module.exports = { THIN_SPEC, assertCollaboratorTargets, installCollaborators };
