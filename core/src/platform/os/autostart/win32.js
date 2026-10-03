'use strict';

const ex = require('../../util/exec');
const BRAND = require('../../../shared/brand');

function hasTask(tn) {
  try {
    const out = ex.runOut('schtasks', ['/Query', '/TN', tn], { stdio: ['ignore', 'pipe', 'ignore'] });
    return !!out && out.includes(tn);
  } catch { return false; }
}

function status() {
  const guard = hasTask(BRAND.WINDOWS_GUARD_TASK);
  const gui = hasTask(BRAND.WINDOWS_GUI_TASK);
  const watchdog = hasTask(BRAND.WINDOWS_WATCHDOG_TASK);
  return { kind: 'schtasks', on: guard || gui || watchdog, gui, watchdog, guard };
}

function setAutostart(on, deps) {
  const errors = [];
  try {
    if (on) {
      const r = ex.runDetail('schtasks', ['/Create', '/TN', BRAND.WINDOWS_GUI_TASK, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/TR', '"' + deps.guiCommand() + '"']);
      if (!r.ok) errors.push('schtasks gui: ' + (r.error || '执行失败'));
    } else {
      if (hasTask(BRAND.WINDOWS_GUI_TASK)) {
        const r = ex.runDetail('schtasks', ['/Delete', '/TN', BRAND.WINDOWS_GUI_TASK, '/F']);
        if (!r.ok) errors.push('schtasks gui delete: ' + (r.error || '执行失败'));
      }
    }
  } catch (e) { errors.push('gui autostart: ' + e.message); }
  return { ok: errors.length === 0, errors, ...status() };
}

// GUI 登录自启：与 setAutostart 同构的真实 schtasks 操作。deps 与 darwin/linux 同口径由 index.js 注入
// （没有 deps 就不知道注册哪个 exe ⇒ 早先版本只能空跑并谎报 ok:true，status() 随即露馅 gui:false）。
function setGuiAutostart(on, deps) {
  if (!deps || typeof deps.guiCommand !== 'function') {
    return { ok: false, platform: 'win32', enabled: false, error: '缺少 guiCommand 依赖，未做任何变更' };
  }
  try {
    if (on) {
      const r = ex.runDetail('schtasks', ['/Create', '/TN', BRAND.WINDOWS_GUI_TASK, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/TR', '"' + deps.guiCommand() + '"']);
      if (!r.ok) return { ok: false, platform: 'win32', enabled: false, via: 'schtasks', task: BRAND.WINDOWS_GUI_TASK, error: r.error || 'schtasks create 失败' };
    } else {
      if (hasTask(BRAND.WINDOWS_GUI_TASK)) {
        const r = ex.runDetail('schtasks', ['/Delete', '/TN', BRAND.WINDOWS_GUI_TASK, '/F']);
        if (!r.ok) return { ok: false, platform: 'win32', enabled: true, via: 'schtasks', task: BRAND.WINDOWS_GUI_TASK, error: r.error || 'schtasks delete 失败' };
      }
    }
    return { ok: true, platform: 'win32', enabled: !!on, via: 'schtasks', task: BRAND.WINDOWS_GUI_TASK };
  } catch (e) {
    return { ok: false, platform: 'win32', enabled: false, error: e.message };
  }
}

module.exports = { status, setAutostart, setGuiAutostart };
