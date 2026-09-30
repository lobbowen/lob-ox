'use strict';

// state.json 原子读写 + main 记录迁移工厂（真 ctor 注入）。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');

function createStore(deps) {
  const g = deps || {};
  const record = g.record;
  const fields = g.fields;
  const mainStore = g.mainStore;
  const upgradeHold = g.upgradeHold;
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  const events = () => (typeof g.getEvents === 'function' ? g.getEvents() : null);
  const instances = () => (typeof g.getInstances === 'function' ? g.getInstances() : null);
  const views = () => (typeof g.getViews === 'function' ? g.getViews() : null);
  const reg = () => (typeof g.getManagedObjects === 'function' ? g.getManagedObjects() : null);
  let lastStateBody = null;

  function writeState(force) {
    try {
      const snap = views().status();
      const updatedAt = snap.updatedAt;
      snap.updatedAt = null;
      const body = JSON.stringify(snap, null, 2);
      if (!force && body === lastStateBody) return;
      lastStateBody = body;
      snap.updatedAt = updatedAt;
      const dir = path.dirname(config().stateFile);
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(config().stateFile, JSON.stringify(snap, null, 2), { mode: 0o600 });
    } catch (e) {
      const l = logger();
      if (l && l.error) l.error('state write failed: ' + e.message);
    }
  }

  function loadState() {
    // 读段只对 ENOENT（首启，正常）保持安静；恢复段失败一律留痕，
    //   否则 shellHalted/upgradeHold/desired 种子丢失无痕可查。
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(config().stateFile, 'utf8'));
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        const l = logger();
        if (l && l.warn) l.warn('state load failed（按空状态继续）: ' + ((e && e.message) || e));
      }
    }
    if (raw && typeof raw === 'object') try {
      // 状态单源：desired 权威是受管目录；仅目录文件不存在时用 state.json 作迁移种子。
      if (raw.desired === 'stopped' || raw.desired === 'running') {
        const m = reg();
        const registryHasSource = !!(m && m._loadedFromDisk);
        if (!registryHasSource) fields.setDesired(raw.desired);
      }
      if (typeof raw.restartCount === 'number') record.fieldOf('restartCount', raw.restartCount, true);
      if (typeof raw.backoffLevel === 'number') record.fieldOf('backoffLevel', raw.backoffLevel, true);
      if (typeof raw.crashWindowStart === 'number' || raw.crashWindowStart === null) record.fieldOf('crashWindowStart', raw.crashWindowStart, true);
      if (typeof raw.crashWindowRestarts === 'number') record.fieldOf('crashWindowRestarts', raw.crashWindowRestarts, true);
      if (typeof raw.lastFailure === 'string' || raw.lastFailure === null) record.procFieldOf('lastFailure', raw.lastFailure, true);
      if (typeof raw.lastRestartAt === 'string' || raw.lastRestartAt === null) record.procFieldOf('lastRestartAt', raw.lastRestartAt, true);
      // 升级 hold 跨守卫重启保持。
      if (raw.upgradeHold === true) upgradeHold.enter();
      // 用户「退出管家」标记跨守卫重启继承（只读 true；清除由看护观测到壳在线时执行）。
      if (raw.shellHalted === true && typeof g.setShellHalted === 'function') g.setShellHalted(true);
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('state restore partial（字段级跳过，boot 仍继续）: ' + ((e && e.message) || e));
    }
    // boot 相位不继承：复位 STOPPED，让首拍按真实探测收敛。
    try { fields.setPhase('STOPPED'); } catch {}
  }

  function migrateMainRecord() {
    try {
      const im = instances();
      if (!im || !Array.isArray(im.instances)) return;
      const idx = im.instances.findIndex((i) => i.id === 'main');
      if (idx < 0) return;
      const main = im.instances[idx];
      const f = mainStore.dshMainFile();
      if (f && !fs.existsSync(f)) {
        mainStore.writeDshMain({
          guardian: main.guardian === true,
          remoteMode: main.remoteEnabled === true ? (main.frpEnabled === true ? 'wan' : 'lan') : 'off',
          remoteToken: String(main.remoteToken || ''),
        });
      }
      im.instances.splice(idx, 1);
      if (im.save) { try { im.save(); } catch {} }
      const l = logger();
      if (l && l.info) l.info('[main] 概念清分：main 记录已迁出 instances.json → dsh-main.json');
      const ev = events();
      if (ev) ev.append('main_meta_migrated', {});
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('_migrateMainRecord: ' + (e && e.message));
    }
  }

  return { writeState, loadState, migrateMainRecord };
}

module.exports = { createStore };
