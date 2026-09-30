'use strict';

// 产品状态根：与 DSH 的 ~/.dsh 完全独立——状态若放在被管控对象的数据目录下，DSH 卸载/清理会连带带走我方状态。
// 覆盖项 DSH_SUPERVISOR_HOME；其余按平台约定（Linux XDG state / macOS Application Support / Windows LOCALAPPDATA），目录为 <root>/supervisor 与 <root>/shell。
// 单一事实源：本模块是内核侧唯一入口；壳侧在壳仓 src-tauri/src/env.rs，两侧 schema 常量由门禁握手锁定。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 契约 schema（与壳 env.rs 的 STATE_ROOT_SCHEMA 握手；门禁锁定）。 */
const SCHEMA = 1;

/** 产品状态根（绝对路径）。 */
function root() {
  const override = process.env.DSH_SUPERVISOR_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'dsh-supervisor');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-supervisor');
  }
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && String(xdg).trim()
    ? path.join(String(xdg).trim(), 'dsh-supervisor')
    : path.join(os.homedir(), '.local', 'state', 'dsh-supervisor');
}

/** 内核状态目录（config/state/ports/logs/events/契约）。 */
function supervisorDir() {
  return path.join(root(), 'supervisor');
}

/** 桌面壳状态目录（identity/mirrors/shell.log）。 */
function shellDir() {
  return path.join(root(), 'shell');
}

/** 旧位置（DSH 数据目录下）——仅用于一次性迁移。 */
function legacySupervisorDir() {
  return path.join(os.homedir(), '.dsh', 'supervisor');
}
function legacyShellDir() {
  return path.join(os.homedir(), '.dsh', 'shell');
}

/** 搬迁失败原因（只取稳定字段：code+message 足够定位，且不丢 errno）。 */
function why(e) { return ((e && e.code) ? e.code + ': ' : '') + ((e && e.message) || String(e)); }

/** 一次性把旧位置（DSH 数据目录下）整目录搬进产品状态根；不双读、不复制。
 *  返回 { moved, skipped, failed }：
 *    moved   已搬走的条目
 *    skipped 新根已有同名条目（新副本为准，旧文件原样留在旧位置——不是失败，但必须可见）
 *    failed  **没能**搬走的条目：旧位置仍有用户数据而未进新根，静默继续等于以空状态启动
 *  失败不在此处重试也不在此处吞掉：调用方据 failed 决定是否启动（「下次启动再试」会把数据缺失
 *  伪装成正常，正是本轮要收口的病）。空目录残留不记失败：它不携带数据，且下次仍然可删。 */
function migrateLegacy() {
  const moved = [];
  const skipped = [];
  const failed = [];
  for (const [from, to] of [
    [legacySupervisorDir(), supervisorDir()],
    [legacyShellDir(), shellDir()],
  ]) {
    if (!fs.existsSync(from)) continue;
    try { fs.mkdirSync(to, { recursive: true }); } catch (e) { failed.push({ from, entry: null, error: why(e) }); continue; }
    let names = [];
    try { names = fs.readdirSync(from); } catch (e) { failed.push({ from, entry: null, error: why(e) }); continue; }
    for (const name of names) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      if (fs.existsSync(dst)) { skipped.push(src); continue; }
      // 跨设备（旧位置在另一挂载点）时 rename 会 EXDEV：如实记失败，不做「复制一份」的第二套真源。
      try { fs.renameSync(src, dst); moved.push(src + ' -> ' + dst); } catch (e) { failed.push({ from, entry: name, error: why(e) }); }
    }
    try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from); } catch { /* 空目录残留，下次再清 */ }
  }
  return { moved, skipped, failed };
}

// legacy* 仅 migrateLegacy 内部使用，不对外导出（收窄公开面）。
module.exports = { SCHEMA, root, supervisorDir, shellDir, migrateLegacy };
