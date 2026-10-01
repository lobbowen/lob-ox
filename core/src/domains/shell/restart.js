'use strict';

const spawnOS = require('../../platform/os/spawn');
const pidlook = require('../../platform/os/pidlookup');

const { identity } = require('./journal');
const { exeFromCmdline, isShellProcess } = require('./core');
const { semverCompare } = require('../../shared/version');

const SHELL_RELEASE_PKG = '@lob-ox/shell-release';

async function checkUpdate(dist, opts) {
  const id = identity();
  const installed = (id && id.version) ? String(id.version) : null;
  if (!dist || typeof dist.fetchLatestVersion !== 'function') {
    return { ok: false, installed, latest: null, updateAvailable: false, error: '分发服务未初始化' };
  }
  try {
    const latest = await dist.fetchLatestVersion(SHELL_RELEASE_PKG, 'npm', { authoritative: (opts && opts.authoritative) === true });
    if (!latest) {
      return { ok: false, installed, latest: null, updateAvailable: false, error: '未查询到壳发布版本（可能尚未发布）' };
    }
    const updateAvailable = Boolean(installed && semverCompare(latest, installed) > 0);
    return { ok: true, installed, latest, updateAvailable };
  } catch (e) {
    return { ok: false, installed, latest: null, updateAvailable: false, error: (e && e.message) || String(e) };
  }
}
async function restartShell(opts) {
  const o = opts || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const pattern = o.procPattern || 'dsh-supervisor-gui';
  let procs = [];
  try { procs = pidlook.pgrepList(pattern) || []; } catch { procs = []; }
  // 与 watchdog 共用 core.js 的 isShellProcess：弱过滤会把 --mirror-plan 等运维自检进程误判为壳并 SIGKILL。
  procs = procs.filter((p) => isShellProcess(p));

  const exe = procs.length ? exeFromCmdline(procs[0].cmdline) : (o.exePath || null);
  if (!exe) return { ok: false, error: '无法定位桌面壳可执行文件（壳未运行且未提供 exePath）' };

  const killed = [];
  for (const p of procs) {
    try { process.kill(p.pid, 'SIGTERM'); killed.push(p.pid); } catch {  }
  }

  const waitGone = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const alive = procs.some((p) => { try { return pidlook.isAlive(p.pid); } catch { return false; } });
      if (!alive) return true;
      await sleep(200);
    }
    return !procs.some((p) => { try { return pidlook.isAlive(p.pid); } catch { return false; } });
  };
  let gone = await waitGone(o.graceMs || 6000);
  if (!gone) {
    for (const p of procs) { try { process.kill(p.pid, 'SIGKILL'); } catch {  } }
    gone = await waitGone(2000);
  }
  if (!gone) {
    return { ok: false, error: '旧壳进程未能在超时内退出，已放弃重启（避免双实例）', killed };
  }

  if (typeof o.shouldAbort === 'function') {
    try {
      if (o.shouldAbort()) return { ok: false, aborted: true, error: '会话已退出/退出中，已放弃拉起桌面壳', killed };
    } catch {}
  }

  try {
    const child = spawnOS.detachedIgnored(exe, [], { env: process.env });
    child.on('error', (e) => {
      try { if (o.events && o.events.append) o.events.append('shell_restart_spawn_error', { exe, error: (e && e.message) || String(e) }); } catch {}
    });
    child.unref();
    if (!child.pid) {
      return { ok: false, error: '拉起新壳失败：子进程未启动（' + exe + ' 不存在或不可执行）', killed };
    }
    return { ok: true, restarted: true, killed, pid: child.pid, exe };
  } catch (e) {
    return { ok: false, error: '拉起新壳失败: ' + ((e && e.message) || e), killed };
  }
}

module.exports = { SHELL_RELEASE_PKG, checkUpdate, restartShell };
