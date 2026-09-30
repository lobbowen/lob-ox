'use strict';

// main 元数据（dsh-main.json）存储工厂（真 ctor 注入）：自己持有 live 缓存与读写实现。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');

function createMainStore(deps) {
  const g = deps || {};
  const config = () => (typeof g.getConfig === 'function' ? (g.getConfig() || {}) : {});
  const logger = () => (typeof g.getLogger === 'function' ? g.getLogger() : null);
  let live = null; // dsh-main.json live 缓存（LanManager mainOf 持同一对象，须原地修改）
  // 文件存在但读/解析失败 -> 置 corrupt，writeDshMain 拒写：否则默认值缓存（remoteToken:''）
  //   会经任一后续写把明文令牌静默清零，且 relay 无声降级为零认证。
  let corrupt = false;

  function dshMainFile() {
    try { return path.join(path.dirname(config().stateFile), 'dsh-main.json'); } catch { return null; }
  }

  /** 按守卫 stateFile 派生，隔离同目录多守卫。 */
  function registryFileName() {
    try {
      const b = path.basename(config().stateFile || 'state.json', '.json');
      return b === 'state' ? 'managed-objects.json' : (b + '.managed-objects.json');
    } catch { return 'managed-objects.json'; }
  }

  function readDshMainFile() {
    try {
      const f = dshMainFile();
      if (f && fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        corrupt = false;
        return {
          guardian: j.guardian === true,
          remoteMode: legacyRemoteMode(j),
          remoteToken: String(j.remoteToken || ''),
        };
      }
    } catch (e) {
      corrupt = true;
      const l = logger();
      if (l && l.warn) l.warn('dsh-main.json 读/解析失败，写回将被拒绝直至显式重设 remoteToken: ' + ((e && e.message) || e));
    }
    return { guardian: false, remoteMode: 'off', remoteToken: '' };
  }

  /** 历史磁盘态一次性推导（legacy 布尔对 -> remoteMode 三态）；首次写盘后旧键即消失。 */
  function legacyRemoteMode(j) {
    if (j.remoteMode === 'lan' || j.remoteMode === 'wan') return j.remoteMode;
    if (j.remoteEnabled === true && j.frpEnabled === true) return 'wan';
    if (j.remoteEnabled === true) return 'lan';
    return 'off';
  }

  /** 读 main 元数据（无文件默认守护关、远程关），缓存到 live。 */
  function readDshMain() {
    if (live) return live;
    live = readDshMainFile();
    return live;
  }

  /** 写 main 元数据（白名单字段，原子写 0600），更新 live 缓存。
   *  fail-closed：corrupt 态拒绝以默认值覆盖写（会静默清零令牌）；
   *  解锁唯一途径是携带显式非空 remoteToken 的写入（= 用户重设令牌）。 */
  function writeDshMain(meta) {
    const m = meta || {};
    if (!live) live = readDshMainFile(); // 可能在此置 corrupt
    if (corrupt && !(typeof m.remoteToken === 'string' && m.remoteToken)) {
      const l = logger();
      if (l && l.warn) l.warn('writeDshMain: 文件损坏态，拒绝以默认值覆盖写回');
      return;
    }
    corrupt = false;
    Object.assign(live, m);
    const f = dshMainFile();
    if (!f) return;
    try {
      const cur = readDshMain();
      const merged = Object.assign({}, cur, m);
      const dir = path.dirname(f);
      fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({
        guardian: merged.guardian === true,
        remoteMode: merged.remoteMode === 'lan' || merged.remoteMode === 'wan' ? merged.remoteMode : 'off',
        remoteToken: String(merged.remoteToken || ''),
      }, null, 2);
      writeAtomic(f, body, { mode: 0o600 });
    } catch (e) {
      const l = logger();
      if (l && l.warn) l.warn('writeDshMain: ' + ((e && e.message) || e));
    }
  }

  return { dshMainFile, registryFileName, readDshMain, readDshMainFile, writeDshMain };
}

module.exports = { createMainStore };
