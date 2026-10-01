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

function setGuiAutostart(on) {
  return { ok: true, platform: 'win32', enabled: !!on, via: 'schtasks', task: BRAND.WINDOWS_GUI_TASK };
}

module.exports = { status, setAutostart, setGuiAutostart };
