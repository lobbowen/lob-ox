'use strict';

const pidlook = require('../os/pidlookup');
const probeModule = require('../util/probe');

function isPortListening(host, port, timeoutMs) {
  return probeModule.portListening(host, port, timeoutMs || 1000);
}

// 端口视角（谁在监听这个端口）：pid + 该 pid 的 cmdline 是否像 DSH。
// 三态：无监听者 / 有监听者且 cmdline 可读 / 有监听者但 cmdline 读不到（身份未知）。
// cmdline 只读一次：身份判据取 pidlookup 的单源 isDshCmdlineText，不在本文件抄第二份 /dsh/i。
function pidState(port) {
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return { pid: null, isDsh: false, cmdlineKnown: false };
  const cmd = pidlook.readCmdline(pid);
  if (!cmd) return { pid, isDsh: false, cmdlineKnown: false };
  return { pid, isDsh: pidlook.isDshCmdlineText(cmd), cmdlineKnown: true };
}

// 端口视角（平台无关）：只回答「谁在监听这个端口」。它不是存活判据——
// 主实例存活由 child 的 exit/close 事件 + 平台 pidlookup 判定（见 app/main/*）。
async function probe(host, port, opts) {
  const o = opts || {};
  const listening = await isPortListening(host, port, o.portTimeoutMs || 1200);
  if (!listening) return { up: false, pid: null, isDsh: false };
  const { pid, isDsh } = pidState(port);
  return { up: pid !== null, pid, isDsh };
}

// 受管实例存活判据（H-02）：拆开「端口被占」与「本实例在跑」两件事。
//   portTaken = 端口上有监听者（无论它是谁）—— 只喂启动前守卫的占用拒绝。
//   running   = 监听者**身份匹配**（cmdline 像 DSH）—— 这才是存活，喂相位迁移/资源采样/重启决策。
// 身份不可知（cmdline 读不到，如权限不足或平台无接口）⇒ running:false + portTaken:true + identityUnknown:true：
//   宁可判「没在跑」（守卫会去重拉，最坏是重复一次启动）也不能判「在跑」（外来进程会顶掉实例，
//   守卫从此不重启、并按外来 pid 采样资源）。identity 证据自此有读者，不再是写而不读。
function probeInstance(inst) {
  const port = inst && inst.port;
  if (!Number.isInteger(port) || port <= 0) {
    return { pid: null, running: false, isDsh: false, portTaken: false, identityUnknown: false, phase: 'STOPPED' };
  }
  const { pid, isDsh, cmdlineKnown } = pidState(port);
  const portTaken = pid !== null;
  const identityUnknown = portTaken && !cmdlineKnown;
  const running = portTaken && cmdlineKnown && isDsh;
  return { pid, running, isDsh, portTaken, identityUnknown, phase: running ? 'RUNNING' : 'STOPPED' };
}

module.exports = { probe, probeInstance, isPortListening };
