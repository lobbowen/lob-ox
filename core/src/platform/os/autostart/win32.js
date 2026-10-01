'use strict';

const ex = require('../../util/exec');

function hasTask(tn) {
  try {
    const out = ex.runOut('schtasks', ['/Query', '/TN', tn], { stdio: ['ignore', 'pipe', 'ignore'] });
    return !!out && out.includes(tn);
  } catch { return false; }
}

function status() {
  const guard = hasTask('DSH-Supervisor');
  const gui = hasTask('DSH-Supervisor-GUI');
  const watchdog = hasTask('DSH-Supervisor-Watchdog');
  return { kind: 'schtasks', on: guard || gui || watchdog, gui, watchdog, guard };
}

function setAutostart(on, deps) {
  const errors = [];
  try {
    if (on) {
      const r = ex.runDetail('schtasks', ['/Create', '/TN', 'DSH-Supervisor-GUI', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F', '/TR', '"' + deps.guiCommand() + '"']);
      if (!r.ok) errors.push('schtasks gui: ' + (r.error || '执行失败'));
    } else {
      if (hasTask('DSH-Supervisor-GUI')) {
        const r = ex.runDetail('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-GUI', '/F']);
        if (!r.ok) errors.push('schtasks gui delete: ' + (r.error || '执行失败'));
      }
    }
  } catch (e) { errors.push('gui autostart: ' + e.message); }
  return { ok: errors.length === 0, errors, ...status() };
}

function setGuiAutostart(on) {
  return { ok: true, platform: 'win32', enabled: !!on, via: 'schtasks', task: 'DSH-Supervisor-GUI' };
}

module.exports = { status, setAutostart, setGuiAutostart };
