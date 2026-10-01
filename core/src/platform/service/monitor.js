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
    httpOk = up;
  }
  return { up, pid, isDsh, httpOk, httpStatus };
}

function probeInstance(inst) {
  const { pid, isDsh } = pidState(inst.port);
  const running = pid !== null;
  return { pid, running, isDsh, phase: running ? 'RUNNING' : 'STOPPED' };
}

module.exports = { probe, probeInstance, isPortListening };
