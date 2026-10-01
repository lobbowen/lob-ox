'use strict';

const pidlook = require('../os/pidlookup');
const probeModule = require('../util/probe');

function isPortListening(host, port, timeoutMs) {
  return probeModule.portListening(host, port, timeoutMs || 1000);
}

function pidState(port) {
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return { pid: null, isDsh: false };
  return { pid, isDsh: pidlook.isDshCmdline(pid) };
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

function probeInstance(inst) {
  const { pid, isDsh } = pidState(inst.port);
  const running = pid !== null;
  return { pid, running, isDsh, phase: running ? 'RUNNING' : 'STOPPED' };
}

module.exports = { probe, probeInstance, isPortListening };
