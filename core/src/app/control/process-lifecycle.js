'use strict';

const procOS = require('../../platform/os/process');
const pidlook = require('../../platform/os/pidlookup');

// 统一进程生命周期原语（S3 / T1）：所有引擎（DSH 主链 signals、路由反代实例、
// 沙箱实例 systemd、桌面壳 restartShell）的「停）语义（SIGTERM → 宽限 → 端口释放核验、
// 外来占用判定）都收敛到这一处，底层 killing 仍委托既有 procOS.killTree / carrier，
// 不改 proven 的杀进程机制，只统一「停之后的判定与等待」。
//
// 这是结构性的收敛（非止血）：新增引擎不得再内联写一份 taskkill/killTree + sleep 轮询，
// 一律走 ProcessLifecycle.stopProcess / waitPortFree / isForeignOnPort。

const DEFAULTS = {
  stopGraceMs: 9000,        // SIGTERM 预算，超时视为未停
  portFreeTimeoutMs: 5000,  // 端口释放核验上限
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 端口上是否蹲着「外来」进程（身份非 ownPid）。H-02：仅判端口被占会误杀健康实例，
// 故停止前/停止后都要区分「端口释放」与「被外来进程抢占」。
function isForeignOnPort(port, ownPid) {
  if (!Number.isInteger(port) || port <= 0) return false;
  const p = pidlook.findListeningPid(port);
  return p !== null && p !== ownPid;
}

async function waitPortFree(port, timeoutMs) {
  const dl = Date.now() + (timeoutMs || DEFAULTS.portFreeTimeoutMs);
  while (Date.now() < dl) {
    if (pidlook.findListeningPid(port) === null) return true;
    await sleep(150);
  }
  return pidlook.findListeningPid(port) === null;
}

// 统一停止：发 SIGTERM（委托 procOS.killTree，ownGroup 可保留），宽限内轮询存活，
// 随后核验端口释放；若被外来进程抢占则如实返回 foreign（不得误判为「已停」）。
async function stopProcess(opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  const pid = (typeof o.pid === 'number') ? o.pid : null;
  const port = (typeof o.port === 'number') ? o.port : null;
  const ownGroup = !!(o.ownGroup);

  if (pid && pid > 0) {
    procOS.killTree(pid, 'SIGTERM', undefined, ownGroup ? { ownGroup: true } : undefined);
  }

  const dl = Date.now() + o.stopGraceMs;
  while (Date.now() < dl) {
    const alive = pid ? (pidlook.isAlive ? pidlook.isAlive(pid) : false) : false;
    if (!alive) break;
    await sleep(150);
  }

  if (port) {
    if (isForeignOnPort(port, pid)) {
      return { ok: false, stopped: false, foreign: true };
    }
    const free = await waitPortFree(port, o.portFreeTimeoutMs);
    if (!free) return { ok: false, stopped: false, portBusy: true };
  }
  return { ok: true, stopped: true };
}

module.exports = { ProcessLifecycle: { stopProcess, waitPortFree, isForeignOnPort, DEFAULTS } };
