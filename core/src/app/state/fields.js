'use strict';

const { ENTRY_FIELDS, PROC_FIELDS } = require('./field-tables');
const { legacyToEntryPhase, entryToLegacyPhase } = require('./phase');

function createFields(deps) {
  const g = deps || {};
  const record = g.record;
  const mainStore = g.mainStore;
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);

  function toEntry(ph) { return legacyToEntryPhase(ph); }
  function toLegacy(ph) { return entryToLegacyPhase(ph); }

  function phase() {
    const e = record.storeOf();
    const p = e.process || null;
    const upper = entryToLegacyPhase(e.phase || 'stopped');
    if (upper === 'STOPPED' && p && p.observedOnly && p.adopted) return 'OBSERVED';
    return upper;
  }

  function setPhase(upper) {
    const e = record.storeOf();
    const ph = legacyToEntryPhase(upper);
    const m = reg();
    try {
      if (m && typeof m.setPhase === 'function' && record.entryOf() === e) {
        if (e.phase !== ph) m.setPhase('main', ph);
      } else {
        record.fieldOf('phase', ph, true);
      }
    } catch (e2) {
      const l = logger();
      if (l && l.warn) l.warn('_mSetPhase: ' + ((e2 && e2.message) || e2));
    }
  }

  function guardian() {
    try { return mainStore.readDshMain().guardian === true; } catch { return false; }
  }

  function mainGuardian() { return guardian(); }

  function desired() { return record.storeOf().desired === 'stopped' ? 'stopped' : 'running'; }

  function setDesired(v) {
    const want = v === 'stopped' ? 'stopped' : 'running';
    const e = record.storeOf();
    const m = reg();
    try {
      if (m && typeof m.update === 'function' && record.entryOf() === e) {
        if (e.desired !== want) m.update('main', { desired: want });
      } else {
        record.fieldOf('desired', want, true);
      }
    } catch (e2) {
      const l = logger();
      if (l && l.warn) l.warn('_mSetDesired: ' + ((e2 && e2.message) || e2));
    }
  }

  function field(name, v) {
    return arguments.length >= 2 ? record.fieldOf(name, v, true) : record.fieldOf(name, undefined, false);
  }
  function procField(name, v) {
    return arguments.length >= 2 ? record.procFieldOf(name, v, true) : record.procFieldOf(name, undefined, false);
  }

  const getProc = (n) => record.procFieldOf(n);
  const setProc = (n, v) => { record.procFieldOf(n, v, true); };
  const getEntry = (n) => record.fieldOf(n);
  const setEntry = (n, v) => { record.fieldOf(n, v, true); };

  const accessors = {
    phase: { get: () => phase(), set: (v) => { setPhase(v); } },
    desired: { get: () => desired(), set: (v) => { setDesired(v); } },
    child: { get: () => getProc('child'), set: (c) => { setProc('child', c); } },
    adoptedPid: { get: () => getProc('adoptedPid'), set: (v) => { setProc('adoptedPid', v); } },
    adopted: { get: () => getProc('adopted') === true, set: (v) => { setProc('adopted', v === true); } },
    observedOnly: { get: () => getProc('observedOnly') === true, set: (v) => { setProc('observedOnly', v === true); } },
    restartCount: { get: () => { const v = getEntry('restartCount'); return typeof v === 'number' ? v : 0; }, set: (v) => { setEntry('restartCount', v); } },
    spawnBlockedUntil: { get: () => { const v = getProc('spawnBlockedUntil'); return v === undefined ? null : v; }, set: (v) => { setProc('spawnBlockedUntil', v); } },
    missingNotified: { get: () => getProc('missingNotified') === true, set: (v) => { setProc('missingNotified', v === true); } },
  };

  return {
    phase, setPhase, guardian, mainGuardian, desired, setDesired,
    field, procField, accessors,
    legacyToEntryPhase: toEntry, entryToLegacyPhase: toLegacy,
    child: () => getProc('child'),
    adoptPid: () => getProc('adoptedPid'),
    observedOnly: () => getProc('observedOnly') === true,
    setObservedOnly: (v) => { setProc('observedOnly', v === true); },
    ENTRY_FIELDS, PROC_FIELDS,
  };
}

module.exports = { createFields };
