'use strict';

const fs = require('node:fs');
const spawner = require('./spawn');
const procOS = require('./process');
const pidlookup = require('./pidlookup');
const { findOurs, portable } = require('./portable');

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

function probe(identity) {
  const ours = findOurs(identity || {});
  if (ours) return { state: 'ours', ...ours };
  const port = Number(identity && identity.port);
  const listening = Number.isInteger(port) && port > 0 ? pidlookup.findListeningPid(port) : null;
  if (listening !== null) return { state: 'foreign', pid: listening };
  return { state: 'dead' };
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
