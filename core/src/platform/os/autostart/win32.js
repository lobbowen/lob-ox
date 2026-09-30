'use strict';

// Windows 自启策略（schtasks DSH-Supervisor-GUI）。schtasks ONLOGON 只在登录时启动一次、崩溃不重启，
// 保活由每 5 分钟检查的 watchdog 任务负责；守卫任务与 watchdog 的所有者都是桌面壳。
// 本模块只管「GUI 壳开机自启」这一个语义：不创建 watchdog、不 enable/disable 守卫任务，否则与壳争定义、形成第二个启动器。

const ex = require('../../util/exec');

/** 任务是否存在（/Query 成功且输出含任务名）。 */
function hasTask(tn) {
  try {
    const out = ex.runOut('schtasks', ['/Query', '/TN', tn], { stdio: ['ignore', 'pipe', 'ignore'] });
    return !!out && out.includes(tn);
  } catch { return false; }
}

/** 自启状态（三个任务职责分离）：DSH-Supervisor 为守卫守护进程（壳建立），
 *  DSH-Supervisor-GUI 为登录时打开桌面壳（本开关管理），DSH-Supervisor-Watchdog 为每 5 分钟保活（归壳）。 */
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
      // 先查再删：任务本就不存在时期望状态已达成，属幂等成功，不得报失败；只有真的发起删除且失败才计入 errors。
      if (hasTask('DSH-Supervisor-GUI')) {
        const r = ex.runDetail('schtasks', ['/Delete', '/TN', 'DSH-Supervisor-GUI', '/F']);
        if (!r.ok) errors.push('schtasks gui delete: ' + (r.error || '执行失败'));
      }
    }
  } catch (e) { errors.push('gui autostart: ' + e.message); }
  return { ok: errors.length === 0, errors, ...status() };
}

/** Windows 的壳自启由 setAutostart 的 schtasks DSH-Supervisor-GUI 承担（职责分离）。 */
function setGuiAutostart(on) {
  return { ok: true, platform: 'win32', enabled: !!on, via: 'schtasks', task: 'DSH-Supervisor-GUI' };
}

module.exports = { status, setAutostart, setGuiAutostart };
