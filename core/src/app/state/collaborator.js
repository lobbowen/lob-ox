'use strict';

// State 协作方工厂（真 ctor 注入）：组合存储原语/字段口/IO 工厂，可独立直测。
// deps 全部为惰性取值函数（装配期 host 尚未就绪），故传 getXxx 而非值。

const { createMainRecord } = require('./main-record');
const { createMainStore } = require('./main-store');
const { createFields } = require('./fields');
const { createStore } = require('./store');
const { createDesired } = require('./desired');
const { createUpgradeHold } = require('./upgrade-hold');

function createStateStore(deps) {
  const g = deps || {};
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);

  const record = createMainRecord({ getManagedObjects: g.getManagedObjects, getLogger: logger });
  const mainStore = createMainStore({ getConfig: g.getConfig, getLogger: logger });
  const fields = createFields({ record, mainStore, getManagedObjects: g.getManagedObjects, getLogger: logger });

  const holder = {};
  const upgradeHold = createUpgradeHold({
    fields, getStore: () => holder.store, getConfig: g.getConfig, getIntents: g.getIntents,
    tick: g.tick, stopProcess: g.stopProcess, setHold: g.setHold, setSince: g.setSince,
  });
  const store = createStore({
    record, fields, mainStore, upgradeHold,
    getConfig: g.getConfig, getLogger: logger, getEvents: g.getEvents,
    getInstances: g.getInstances, getViews: g.getViews, getManagedObjects: g.getManagedObjects,
    getShellHalted: g.getShellHalted, setShellHalted: g.setShellHalted,
  });
  holder.store = store;

  const desired = createDesired({
    fields, store, getIntents: g.getIntents, getEvents: g.getEvents,
    getConfigPath: g.getConfigPath, getConfigAliases: g.getConfigAliases, getLogger: logger,
    setCrashHalted: g.setCrashHalted, setManualRestart: g.setManualRestart,
    tick: g.tick, stopProcess: g.stopProcess,
  });

  // 协作方公共接口（SPEC：state.*）+ 宿主兼容所需的其余真实现
  return {
    // 公共接口
    phase: fields.phase, setPhase: fields.setPhase, guardian: fields.guardian,
    desired: fields.desired, setDesired: fields.setDesired,
    field: fields.field, procField: fields.procField,
    store: record.storeOf, dshEntry: record.entryOf,
    mainMetaFile: mainStore.dshMainFile, readMainMeta: mainStore.readDshMain,
    writeMainMeta: mainStore.writeDshMain,
    write: store.writeState, persistConfigPatch: desired.persistConfigPatch,
    // 宿主兼容（对应既有 host 方法名；见 assembly/collaborators.js）
    mainGuardian: fields.mainGuardian,
    legacyToEntryPhase: fields.legacyToEntryPhase, entryToLegacyPhase: fields.entryToLegacyPhase,
    accessors: fields.accessors,
    child: fields.child, adoptPid: fields.adoptPid,
    observedOnly: fields.observedOnly, setObservedOnly: fields.setObservedOnly,
    loadState: store.loadState, migrateMainRecord: store.migrateMainRecord,
    readMainMetaFile: mainStore.readDshMainFile, registryFileName: mainStore.registryFileName,
    fallbackEntry: record.fallbackEntryOf, persistCrashField: record.persistCrashField,
    fieldOf: record.fieldOf, procFieldOf: record.procFieldOf,
    setDesiredPublic: desired.setDesired, requestRestart: desired.requestRestart,
    enterUpgradeHold: upgradeHold.enter, enterUpgradeHoldAsync: upgradeHold.enterAsync,
    exitUpgradeHold: upgradeHold.exit,
  };
}

module.exports = { createStateStore };
