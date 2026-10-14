'use strict';

const fs = require('node:fs');
const spawner = require('./spawn');
const procOS = require('./process');
const pidlookup = require('./pidlookup');
const { findOurs, portable } = require('./portable');
const { judge: judgeIdentity } = require('./liveness');

const ESCALATE_MS = 1500;

function escalateKill(pid) {
  setTimeout(() => {
    if (!pidlookup.isAlive(pid)) return;
    try { procOS.killTree(pid, 'SIGKILL', undefined, { ownGroup: true }); } catch {  }
  }, ESCALATE_MS).unref();
}

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
    try { fs.writeFileSync(identity.pidFile, String(child.pid)); } catch {  }
  }
  if (typeof o.onOutput === 'function') o.onOutput(child);
  return { pid: child.pid, child, identity };
}

// 与 portable.isUnitActive / monitor.probeInstance 同源：judge 的 state 即结论。
// 原先此处把「有监听无锚点」硬判为 foreign，而 monitor 对同一观测返回 running=true。
function probe(identity) {
  const id = identity || {};
  const v = judgeIdentity({
    pidFile: id.pidFile || null,
    port: Number(id.port) || 0,
    anchors: Array.isArray(id.anchors) ? id.anchors : [],
  });
  return { state: v.state, pid: v.pid === undefined ? null : v.pid, via: v.via, evidence: v.evidence };
}

function signalTermination(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { procOS.killTree(pid, 'SIGTERM', undefined, { ownGroup: true }); } catch { return false; }
  escalateKill(pid);
  return true;
}

function stop(identity, opts) {
  return portable.stopUnit(null, Object.assign({}, identity || {}, opts || {}));
}

module.exports = { start, probe, signalTermination, stop };
