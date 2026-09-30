'use strict';

// 平台能力：在线探测（守卫与各域共用的纯探测，无生命周期动作），原生与沙箱实例统一适用。
// 绝不拉起/接管/做任何生命周期动作，结果仅作观测/决策依据。

const pidlook = require('../os/pidlookup');
const probeModule = require('../util/probe');

/** 端口是否被监听（占用检查）。 */
function isPortListening(host, port, timeoutMs) {
  return probeModule.portListening(host, port, timeoutMs || 1000);
}

/** 统一目标在线判定核心。语义：up/running 只以端口有进程监听为准；isDsh 仅作标注
 *  （接管时由 supervisor 用启动命令精确校验），不参与在线判定 —— 否则 DSH 装在路径不含
 *  dsh 的目录就永不在线。 */
function pidState(port) {
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return { pid: null, isDsh: false };
  return { pid, isDsh: pidlook.isDshCmdline(pid) };
}

/** 统一健康探测（L1 端口在线且有监听 pid + L2 HTTP；L0 进程存活由调用方/tick 承担）：
 *  L2 GET healthUrl 2xx（401/403 认证响应视为在线；httpProbeEnabled=false 时退化为 up）。
 *  @param opts { portTimeoutMs?, httpProbeEnabled?, healthUrl?, httpTimeoutMs? }
 *  @returns {{ up:boolean, pid:number|null, isDsh:boolean, httpOk:boolean, httpStatus:number|null }} */
async function probe(host, port, opts) {
  const o = opts || {};
  const listening = await isPortListening(host, port, o.portTimeoutMs || 1200);
  if (!listening) return { up: false, pid: null, isDsh: false, httpOk: false, httpStatus: null };
  const { pid, isDsh } = pidState(port);
  const up = pid !== null;
  let httpOk = false;
  let httpStatus = null;
  if (o.httpProbeEnabled !== false && o.healthUrl) {
    const r = await probeModule.httpProbe(o.healthUrl, o.httpTimeoutMs || 3000);
    httpOk = r.ok;
    httpStatus = r.status;
  } else {
    // 关闭 HTTP 探测（自定义非 HTTP 命令）：端口在线即视为健康
    httpOk = up;
  }
  return { up, pid, isDsh, httpOk, httpStatus };
}

/** 探测单个实例状态（沙箱/原生实例）。inst = { port }。
 *  @returns {{ pid:number|null, running:boolean, isDsh:boolean, phase:string }} */
function probeInstance(inst) {
  const { pid, isDsh } = pidState(inst.port);
  const running = pid !== null;
  return { pid, running, isDsh, phase: running ? 'RUNNING' : 'STOPPED' };
}

module.exports = { probe, probeInstance, isPortListening };
