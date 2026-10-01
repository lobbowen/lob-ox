'use strict';

const ex = require('../util/exec');

const isWindows = process.platform === 'win32';

function signalProcess(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    try { process.kill(pid, sig); } catch {}
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

// Windows taskkill 必带 /F（无 /F 只投 WM_CLOSE，无窗口子进程杀不掉仍占端口）+ 10s 有界超时；/T 对外来 pid 安全。
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
