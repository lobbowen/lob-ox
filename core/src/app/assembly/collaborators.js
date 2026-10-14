'use strict';

const { createStateStore } = require('../state/collaborator');
const { createSession } = require('../session/machine');
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
    startWindowMs: 'startWindowMs',
    adopt: '_adopt', adoptObserved: '_adoptObserved',
    applyPort: '_applyMainPort', beginRestart: '_beginRestart', enterRunning: '_enterRunning',
    findManagedPort: '_findManagedDshPort',
    startProcess: '_startProcess', stopProcess: 'stopProcess',
    isManagedProcess: '_isManagedProcess', killAdopted: '_killAdopted', killSequence: '_killSequence',
  },
  views: {
    dshMain: 'dshMainView',
    routerDaemonActive: 'routerDaemonActive', routerStatus: 'routerStatus',
    status: 'statusSummary',
  },
  ui: { notify: 'notify' },
};
const THIN_NAMES = Object.keys(THIN_SPEC);

// 消费者驱动的接口自检。
//
// THIN_SPEC 原有 assertCollaboratorTargets 只证明「源函数存在」，证明不了：
//   1. 消费者读的属性名是否真的被 installThin 生成（拼错只在首次调用时 TypeError）；
//   2. 源方法改名后消费者是否同步（字符串间接层，无工具可发现）。
// 这里在安装后生成每个 collaborator 的公开面快照，供启动自检与测试比对。
function collaboratorSurface(host, name) {
  const obj = host[name];
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).sort();
}

// 消费者侧调用：取不到就立刻抛错，错误信息带上期望的接口面，
// 而不是让 TypeError 在第一次真实调用时才暴露。
function requireThin(host, name, prop) {
  const obj = host[name];
  if (!obj || typeof obj[prop] !== 'function') {
    const have = collaboratorSurface(host, name);
    throw new Error('app/assembly/collaborators: ' + name + '.' + prop
      + ' 不存在（当前接口面: ' + (have.join(', ') || '空') + '）');
  }
  return obj[prop];
}
function assertCollaboratorTargets(host) {
  const missing = [];
  for (const name of THIN_NAMES) {
    for (const [pub, src] of Object.entries(THIN_SPEC[name])) {
      if (typeof host[src] !== 'function') missing.push(name + '.' + pub + ' -> ' + src);
    }
  }
  if (missing.length) throw new Error('app/assembly/collaborators: 接口表指向缺失方法: ' + missing.join(', '));
  // 第二重：安装后的公开面必须非空。源函数都在但 installThin 没跑，
  // 或 THIN_SPEC 某个分组被清空，都会在这里暴露。
  const empty = THIN_NAMES.filter((n) => collaboratorSurface(host, n).length === 0);
  if (empty.length) throw new Error('app/assembly/collaborators: 接口面为空: ' + empty.join(', '));
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
    getInstances: () => host.instances,
    getViews: () => host.views, getIntents: () => host.intents,
    getCrashHalted: () => host._crashHalted, setCrashHalted: (v) => { host._crashHalted = v; },
    getManualRestart: () => host.manualRestart, setManualRestart: (v) => { host.manualRestart = v; },
    getShellHalted: () => host._shellHalted, setShellHalted: (v) => { host._shellHalted = v; },
    stopProcess: (why) => host.stopProcess(why),
    // 收敛拍的真实实现是 host.main.converge()（controller._dshConverge），
    // 由 assembly/bootstrap.js:48 注册进 BeatScheduler。此处必须在调用时再解析，
    // 因为 collaborators 先于 main 装配；早绑会把 undefined 烤进闭包，
    // 而 desired.js:18 的 typeof 守卫只检查这个恒为函数的包装，恒被绕过。
    tick: () => { if (host.main && typeof host.main.converge === 'function') host.main.converge(); },
  });
  host.state = state;

  host._mPhase = () => state.phase();
  host._mSetPhase = (u) => { state.setPhase(u); return host; };
  // 原下一行 host.mainGuardian = () => state.mainGuardian() 已删除：createStateStore
  // 从不返回 mainGuardian 键（全仓仅该行命中此名），调用即 TypeError，且无消费方。
  host._mDesired = () => state.desired();
  host._mSetDesired = (v) => { state.setDesired(v); return host; };
  host._readDshMain = () => state.readMainMeta();
  host.writeState = (force) => state.write(force);
  host.loadState = () => state.loadState();
  host._migrateMainRecord = () => state.migrateMainRecord();
  host.setDesired = (v) => state.setDesiredPublic(v);
  host.requestRestart = () => state.requestRestart();
  host.persistConfigPatch = (patch) => state.persistConfigPatch(patch);
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
  host.sessionState = () => { const p = String(host._mPhase ? host._mPhase() : '' || '').toUpperCase(); return (p === 'STARTING' || p === 'RUNNING') ? 'running' : 'stopped'; };
  host._setSessionState = (s) => { session.setState(s); };
  host._sessionHalting = () => session.halting();
  host._exitIntended = () => !!(host._stopping || session.halting());
  host._shellExitIntended = () => !!(host._exitIntended() || host._shellHalted);
  Object.defineProperty(host, '_sessionState', {
    get: () => session.state(),
    set: (s) => { session.setState(s); },
  });
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
  installThin(host);
  installCtlFactory(host);
  installAuditFactory(host);
  if (options && options.validate) assertCollaboratorTargets(host);
  return host;
}

module.exports = { THIN_SPEC, assertCollaboratorTargets, installCollaborators, collaboratorSurface, requireThin };
