'use strict';

// POSIX（Linux/macOS）用进程组信号 kill(-pid)；Windows 无进程组语义，用 taskkill /T 整树终止（能力等价）。
// 异步外部命令一律走 platform/util/exec 的有界封装（timeout/SIGKILL/windowsHide 纪律收口在那）。

const ex = require('../util/exec');

const isWindows = process.platform === 'win32';

/** 向进程（组）发信号：POSIX 先组信号（-pid），失败退单进程；
 *  Windows 仅单进程（树语义由 killTree 提供）。 */
function signalProcess(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    try { process.kill(pid, sig); } catch {}
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

/** 整树终止（尽力而为，回调式）。
 *  Windows taskkill 必带 /F（无 /F 只投递 WM_CLOSE，无窗口/不处理该消息的子进程杀不掉仍占端口）且带 10s 有界超时；
 *  /T 按父子枚举对外来 pid 同样安全，故 Windows 侧不需要 ownGroup 前提。
 *  POSIX 组信号仅限本方创建的进程组（ownGroup=true）：接管来的 pid 可能恰是无关组（如用户 shell）组长，kill(-pid) 会误杀整组，外来路径只发单进程信号。 */
function killTree(pid, sig, cb, opts) {
  if (!Number.isInteger(pid) || pid <= 0) { if (cb) cb(new Error('invalid pid')); return; }
  if (isWindows) {
    ex.runAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 10000 })
      .then((r) => { if (cb) cb(r.ok ? null : new Error(r.error || 'taskkill failed')); });
    return;
  }
  if (opts && opts.ownGroup === true) {
    signalProcess(pid, sig || 'SIGTERM');
  } else {
    try { process.kill(pid, sig || 'SIGTERM'); } catch {}
  }
  if (cb) process.nextTick(cb, null);
}

module.exports = { signalProcess, killTree };
