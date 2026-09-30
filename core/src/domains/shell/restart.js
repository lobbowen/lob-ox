'use strict';

const spawnOS = require('../../platform/os/spawn');
const pidlook = require('../../platform/os/pidlookup');

// 壳版本检测 / 壳重启（有 IO/进程副作用），与纯状态账本 journal.js 分离。
// 硬约束：绝不触碰内核既有更新机制；此处只做版本检测（不安装），
// 重启只是把控制权交回壳的门 0（壳自更新）。

const { identity } = require('./journal');
// 纯解析/谓词取自 core.js（顶层依赖），避免重启流程反向依赖看护模块。
const { exeFromCmdline, isShellProcess } = require('./core');
// 版本比较复用内核同一份实现（shared/version），避免两处 semver 语义分叉。
const { semverCompare } = require('../../shared/version');

/** 壳发布清单包：壳产物按平台分包但版本始终一致，查此包即得最新壳版本，无需在本机判断平台。 */
const SHELL_RELEASE_PKG = '@dsh-sup/shell-release';

/** 检测壳是否有新版本（npm registry + 镜像回退）。内核不是壳的更新源，只检测不安装。
 *  dist: DistributionManager；返回 { ok, installed, latest, updateAvailable, error? }。 */
async function checkUpdate(dist, opts) {
  const id = identity();
  const installed = (id && id.version) ? String(id.version) : null;
  if (!dist || typeof dist.fetchLatestVersion !== 'function') {
    return { ok: false, installed, latest: null, updateAvailable: false, error: '分发服务未初始化' };
  }
  try {
    // shell-release 属我方发布 scope-> 走通道控制
    //（rollback -> canary -> latest；latest 缺失才回落最高）。
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
/** 重启桌面壳以应用壳更新：壳自更新发生在壳启动时（门 0），故「用上新版本」= 让壳重启一次。
 *  必须等旧壳真正退出再拉起（壳装了 single-instance，旧实例在则新实例只唤起旧窗口后自行退出）；
 *  SIGTERM -> 有界等待 -> 必要时 SIGKILL -> 再等待，都不成功则明确失败不静默。
 *  返回 { ok, restarted?, killed?, pid?, error? }。 */
async function restartShell(opts) {
  const o = opts || {};
  // 经统一封装异步 spawn（固定 windowsHide:true）：detached 壳否则会新开 Windows 控制台窗口。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 进程匹配名可配置（自定义安装名），并让测试注入不存在的名字，避免误杀本机真实壳进程。
  const pattern = o.procPattern || 'dsh-supervisor-gui';
  let procs = [];
  try { procs = pidlook.pgrepList(pattern) || []; } catch { procs = []; }
  // 与 watchdog 共用 core.js 的 isShellProcess：弱过滤会把 --mirror-plan 等运维自检进程误判为壳并 SIGKILL。
  procs = procs.filter((p) => isShellProcess(p));

  const exe = procs.length ? exeFromCmdline(procs[0].cmdline) : (o.exePath || null);
  if (!exe) return { ok: false, error: '无法定位桌面壳可执行文件（壳未运行且未提供 exePath）' };

  const killed = [];
  for (const p of procs) {
    try { process.kill(p.pid, 'SIGTERM'); killed.push(p.pid); } catch { /* 已退出 */ }
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
    for (const p of procs) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* 忽略 */ } }
    gone = await waitGone(2000);
  }
  if (!gone) {
    return { ok: false, error: '旧壳进程未能在超时内退出，已放弃重启（避免双实例）', killed };
  }

  // 在飞复判：杀旧壳 + 等待最长约 8s 期间用户可能发起「退出管家」，spawn 前必须再判一次，
  // 否则退出请求与重启赛跑，刚退出的壳被拉回（与看护门同源缺陷）。
  if (typeof o.shouldAbort === 'function') {
    try {
      if (o.shouldAbort()) return { ok: false, aborted: true, error: '会话已退出/退出中，已放弃拉起桌面壳', killed };
    } catch {}
  }

  // 拉起新壳（门 0 在其启动时执行：检测 -> 下载 -> 验签 -> 安装 -> 重启进新版）。
  // 必须监听 'error' 且不能以 spawn 返回即报成功：Node 对不存在的可执行文件不抛同步错，
  // 只异步发 'error'；无监听会逃逸为 uncaughtException（守卫对频繁未捕获异常会自杀），
  // 且 watchdog 收到 ok:true 会假成功、清 missingSince，形成每 90s 一拍的慢速重启风暴。
  try {
    const child = spawnOS.detachedIgnored(exe, [], { env: process.env });
    // 此刻已无法回滚「壳没起来」，只如实记事件让 watchdog/面板可见。
    child.on('error', (e) => {
      // 本模块无 logger 依赖，事件经可选 opts.events 注入。
      try { if (o.events && o.events.append) o.events.append('shell_restart_spawn_error', { exe, error: (e && e.message) || String(e) }); } catch {}
    });
    child.unref();
    // 同步可判的失败：ENOENT 时 spawn 返回的 child.pid 为 undefined。
    if (!child.pid) {
      return { ok: false, error: '拉起新壳失败：子进程未启动（' + exe + ' 不存在或不可执行）', killed };
    }
    // 记账交给 API 层。
    return { ok: true, restarted: true, killed, pid: child.pid, exe };
  } catch (e) {
    return { ok: false, error: '拉起新壳失败: ' + ((e && e.message) || e), killed };
  }
}

module.exports = { SHELL_RELEASE_PKG, checkUpdate, restartShell };
