'use strict';

const { createMainRecord } = require('./main-record');
const { createMainStore } = require('./main-store');
const { createFields } = require('./fields');
const { createStore } = require('./store');
const { createDesired } = require('./desired');

function createStateStore(deps) {
  const g = deps || {};
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);

  const record = createMainRecord({ getManagedObjects: g.getManagedObjects, getLogger: logger });
  const mainStore = createMainStore({ getConfig: g.getConfig, getLogger: logger });
  const fields = createFields({ record, mainStore, getManagedObjects: g.getManagedObjects, getLogger: logger });

  const holder = {};
    const store = createStore({
    record, fields, mainStore,
    getConfig: g.getConfig, getLogger: logger, getEvents: g.getEvents,
    getInstances: g.getInstances, getViews: g.getViews, getManagedObjects: g.getManagedObjects,
    getShellHalted: g.getShellHalted, setShellHalted: g.setShellHalted,
  });
  holder.store = store;

  const desired = createDesired({
    fields, store, getIntents: g.getIntents, getEvents: g.getEvents,
    getConfigPath: g.getConfigPath, getConfigAliases: g.getConfigAliases, getLogger: logger,
    setCrashHalted: g.setCrashHalted, setManualRestart: g.setManualRestart,
    // 壳状态同步成功回执 ⇒ 清「壳让停」旧标记。缺这两个 setter 时清除静默不执行
    // （desired.js 内部按 null 跳过）⇒ 那正是本次要修的静默失败，不能以同样形态引入。
    getShellHalted: g.getShellHalted, setShellHalted: g.setShellHalted,
    tick: g.tick, stopProcess: g.stopProcess,
  });

  return {
    phase: fields.phase, setPhase: fields.setPhase,
    desired: fields.desired, setDesired: fields.setDesired,
    field: fields.field, procField: fields.procField,
    store: record.storeOf, dshEntry: record.entryOf,
    mainMetaFile: mainStore.dshMainFile, readMainMeta: mainStore.readDshMain,
      fallbackEntry: record.fallbackEntryOf,
    writeMainMeta: mainStore.writeDshMain,
    write: store.writeState, persistConfigPatch: desired.persistConfigPatch,
      accessors: fields.accessors,
    loadState: store.loadState, migrateMainRecord: store.migrateMainRecord,
    setDesiredPublic: desired.setDesired, requestRestart: desired.requestRestart,
  };
}

module.exports = { createStateStore };
