'use strict';

const procOS = require('../../platform/os/process');
const pidlook = require('../../platform/os/pidlookup');

const DEFAULTS = {
  stopGraceMs: 9000,        
  portFreeTimeoutMs: 5000,  
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
