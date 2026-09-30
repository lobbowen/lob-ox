'use strict';

// app/state/fields.js —— 状态字段口工厂（真 ctor 注入；phase/desired 真身，可独立直测）。
// 纯映射/字段表在 phase.js / field-tables.js。

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

  /** 读守卫视角 phase（大写；OBSERVED 按 observedOnly+adopted 合成）。守卫内唯一 phase 读口。 */
  function phase() {
    const e = record.storeOf();
    const p = e.process || null;
    const upper = entryToLegacyPhase(e.phase || 'stopped');
    if (upper === 'STOPPED' && p && p.observedOnly && p.adopted) return 'OBSERVED';
    return upper;
  }

  /** 写守卫视角 phase（大写经 registry.setPhase 转目录 canonical）。 */
  function setPhase(upper) {
    const e = record.storeOf();
    const ph = legacyToEntryPhase(upper);
    const m = reg();
    try {
      if (m && typeof m.setPhase === 'function' && record.entryOf() === e) {
        if (e.phase !== ph) m.setPhase('main', ph);
      } else {
        // 兜底直写并入唯一字段写口 record.fieldOf（B2-3）：fallback 期的值走草稿回填，不再各写各的。
        record.fieldOf('phase', ph, true);
      }
    } catch (e2) {
      const l = logger();
      if (l && l.warn) l.warn('_mSetPhase: ' + ((e2 && e2.message) || e2));
    }
  }

  /** 读守护开关（dsh-main.json meta.guardian；守卫内唯一 guardian 读口）。 */
  function guardian() {
    try { return mainStore.readDshMain().guardian === true; } catch { return false; }
  }

  /** main 守护开关公开门面（与 guardian 同源）。 */
  function mainGuardian() { return guardian(); }

  /** 读 desired（running|stopped）。守卫内唯一 desired 读口。 */
  function desired() { return record.storeOf().desired === 'stopped' ? 'stopped' : 'running'; }

  /** 写 desired（registry.update 持久化）。 */
  function setDesired(v) {
    const want = v === 'stopped' ? 'stopped' : 'running';
    const e = record.storeOf();
    const m = reg();
    try {
      if (m && typeof m.update === 'function' && record.entryOf() === e) {
        if (e.desired !== want) m.update('main', { desired: want });
      } else {
        // 兜底直写并入唯一字段写口 record.fieldOf（B2-3）。
        record.fieldOf('desired', want, true);
      }
    } catch (e2) {
      const l = logger();
      if (l && l.warn) l.warn('_mSetDesired: ' + ((e2 && e2.message) || e2));
    }
  }

  /** entry 字段读写（write 语义见 record.fieldOf）。 */
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

  // 兼容访问器（get/set 描述符；安装到 host 实例）
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
