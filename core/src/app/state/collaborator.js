'use strict';

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

  return {
    phase: fields.phase, setPhase: fields.setPhase, guardian: fields.guardian,
    desired: fields.desired, setDesired: fields.setDesired,
    field: fields.field, procField: fields.procField,
    store: record.storeOf, dshEntry: record.entryOf,
    mainMetaFile: mainStore.dshMainFile, readMainMeta: mainStore.readDshMain,
    registryFileName: mainStore.registryFileName,
    fallbackEntry: record.fallbackEntryOf,
    writeMainMeta: mainStore.writeDshMain,
    write: store.writeState, persistConfigPatch: desired.persistConfigPatch,
    mainGuardian: fields.mainGuardian,
    accessors: fields.accessors,
    loadState: store.loadState, migrateMainRecord: store.migrateMainRecord,
    setDesiredPublic: desired.setDesired, requestRestart: desired.requestRestart,
    enterUpgradeHold: upgradeHold.enter, enterUpgradeHoldAsync: upgradeHold.enterAsync,
    exitUpgradeHold: upgradeHold.exit,
  };
}

module.exports = { createStateStore };
