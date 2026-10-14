'use strict';

const pidlook = require('../os/pidlookup');
const { judge: judgeIdentity } = require('../os/liveness');
const probeModule = require('../util/probe');

function isPortListening(host, port, timeoutMs) {
  return probeModule.portListening(host, port, timeoutMs || 1000);
}

function matchesAnchors(pid, anchors) {
  return judgeIdentity({ pid, anchors }).state === 'ours';
}

// 端口观测 -> 身份判定的唯一入口（liveness.judge）。TCP 可连但 cmdline 不可读时，
// judge 返回 unknown —— 「有人在监听」不是「我们的实例在跑」（端口是共享事实，不是身份）。
function judgePort(port, anchors) {
  return judgeIdentity({ port, anchors });
}

async function probe(host, port, opts) {
  const o = opts || {};
  const listening = await isPortListening(host, port, o.portTimeoutMs || 1200);
  if (!listening) return { up: false, pid: null, isDsh: false };
  const v = judgePort(port, []);
  return { up: v.state !== 'dead', pid: v.pid, isDsh: v.state === 'ours' };
}

const IDLE = Object.freeze({
  pid: null, running: false, isDsh: false, portTaken: false, identityUnknown: false, phase: 'STOPPED',
});

function probeInstance(inst, opts) {
  const o = opts || {};
  const port = inst && inst.port;
  if (!Number.isInteger(port) || port <= 0) return Object.assign({}, IDLE);
  const anchors = Array.isArray(o.anchors) ? o.anchors : [];
  const v = judgePort(port, anchors);
  if (v.state === 'dead') return Object.assign({}, IDLE);
  const running = v.state === 'ours';
  return {
    pid: v.pid,
    running,
    isDsh: running,
    portTaken: true,
    // 与 judge 的 unknown 同义：证据不足，不默认肯定。此前这里对"无锚点/cmdline 不可读"
    // 返回 running=true，与 os/portable.js 同一观测判 UNKNOWN 矛盾。
    identityUnknown: v.state === 'unknown',
    phase: running ? 'RUNNING' : 'STOPPED',
  };
}

module.exports = { probe, probeInstance, isPortListening, matchesAnchors, judgePort };
