'use strict';

// 受管进程载体：反代进程池这类「需管道读输出、长驻管理」的池式消费者拉起外部进程的唯一通道；
// 与 portable.startTransient（守卫式拉起，stdio ignore、无句柄）的分工是本模块做池式拉起。
// 归属/终止语义全仓唯一（PROXY-ISOLATION-STANDARD L1）：平台事实下沉 L0（os/spawn、os/process#killTree、os/pidlookup，无 process.platform 分支），身份判定只走 portable.findOurs（run.pid + 端口反查 + 锚点，防 PID 复用误杀）；域内不得自带 process.kill(-pid)/sameProcessGroup（win32 无进程组语义EINVAL、macOS 无 /proc 恒误判孤儿），整树终止走 killTree。

const fs = require('node:fs');
const spawner = require('./spawn');
const procOS = require('./process');
const pidlookup = require('./pidlookup');
const { findOurs, portable } = require('./portable');

/** 终止在途台账：pid -> 升级定时器。SIGTERM 后到期未退自动 SIGKILL 整树。
 *  1.5s 与反代既有停止预算一致；定时器 unref，绝不因滞留台账钉住事件循环。 */
const ESCALATE_MS = 1500;

function escalateKill(pid) {
  setTimeout(() => {
    if (!pidlookup.isAlive(pid)) return;
    try { procOS.killTree(pid, 'SIGKILL', undefined, { ownGroup: true }); } catch { /* 已退出 */ }
  }, ESCALATE_MS).unref();
}

/** 拉起并纳管：detached（POSIX 自成进程组，ownGroup 组信号前提）+ 管道句柄。
 *  @param {{cmd:string[], env?:object, cwd?:string, identity:{port?:number,pidFile?:string,anchors?:string[]}, onOutput?:(child:import('node:child_process').ChildProcess)=>void}} spec
 *  identity.anchors 必含同时出现在「载体进程」与「其子孙监听者」cmdline 的特征串（约定为包名 + '--port <端口>'）；onOutput 由调用方接线 stdout/stderr。
 *  @returns {{pid:number, child:import('node:child_process').ChildProcess, identity:object}} */
function start(spec) {
  const o = spec || {};
  const cmd = o.cmd || [];
  if (!cmd.length) throw new Error('carrier.start 拒绝：空命令');
  const identity = o.identity || {};
  const child = spawner.piped(cmd[0], cmd.slice(1), {
    detached: true,
    cwd: o.cwd || undefined,
    env: o.env,
  });
  if (!child.pid) throw new Error('carrier.start 失败：spawn 未产生进程');
  if (identity.pidFile) {
    // run.pid 是「监听前窗口」的停止兜底；写失败不构成启动失败（端口+锚点仍可判定归属）。
    try { fs.writeFileSync(identity.pidFile, String(child.pid)); } catch { /* ignore */ }
  }
  if (typeof o.onOutput === 'function') o.onOutput(child);
  return { pid: child.pid, child, identity };
}

/** 归属快照（三态语义与 portable.isUnitActive 同口径）：
 *  'ours'=锚点命中的我方进程（{pid,ownGroup}）；'dead'=无归属进程；
 *  'foreign'=端口被 cmdline 不匹配锚点的进程占住（绝不据 pid 相等/进程组臆断）。 */
function probe(identity) {
  const ours = findOurs(identity || {});
  if (ours) return { state: 'ours', ...ours };
  const port = Number(identity && identity.port);
  const listening = Number.isInteger(port) && port > 0 ? pidlookup.findListeningPid(port) : null;
  if (listening !== null) return { state: 'foreign', pid: listening };
  return { state: 'dead' };
}

/** 发 SIGTERM 整树（fire-and-forget，1.5s 自动升级 SIGKILL）+ 台账。
 *  只用于「我们刚拉起的组长 pid」——ownGroup:true 的前提是本方 detached 创建，
 *  外来 pid 的终止一律走 stop()（锚点复核）或调用方显式 killTree(ownGroup:false)。 */
function signalTermination(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { procOS.killTree(pid, 'SIGTERM', undefined, { ownGroup: true }); } catch { return false; }
  escalateKill(pid);
  return true;
}

/** 确认式停止（有界同步复核，语义 = portable.stopUnit）：锚点复核后才动手，
 *  true=已确认消失 / false=未确认（调用方保持原相位，不得当成功）。
 *  注意：预算内 Atomics.wait 阻塞调用线程，只可在关停/低频路径用；请求路径用 signalTermination。 */
function stop(identity, opts) {
  return portable.stopUnit(null, Object.assign({}, identity || {}, opts || {}));
}

module.exports = { start, probe, signalTermination, stop };
