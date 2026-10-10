'use strict';

const pidlook = require('../os/pidlookup');
const probeModule = require('../util/probe');

function isPortListening(host, port, timeoutMs) {
  return probeModule.portListening(host, port, timeoutMs || 1000);
}

function pidState(port) {
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return { pid: null, isDsh: false, cmdlineKnown: false };
  const cmd = pidlook.readCmdline(pid);
  if (!cmd) return { pid, isDsh: false, cmdlineKnown: false };
  return { pid, isDsh: pidlook.isDshCmdlineText(cmd), cmdlineKnown: true };
}

async function probe(host, port, opts) {
  const o = opts || {};
  const listening = await isPortListening(host, port, o.portTimeoutMs || 1200);
  if (!listening) return { up: false, pid: null, isDsh: false };
  const { pid, isDsh } = pidState(port);
  return { up: pid !== null, pid, isDsh };
}

function matchesAnchors(pid, anchors) {
  if (!pid || !Array.isArray(anchors) || !anchors.length) return false;
  const cmd = pidlook.readCmdline(pid);
  if (!cmd) return false;
  return anchors.every((a) => a && cmd.indexOf(String(a)) !== -1);
}

function probeInstance(inst, opts) {
  const o = opts || {};
  const port = inst && inst.port;
  const idle = { pid: null, running: false, isDsh: false, portTaken: false, identityUnknown: false, phase: 'STOPPED' };
  if (!Number.isInteger(port) || port <= 0) return idle;
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return idle;
  const cmd = pidlook.readCmdline(pid);
  const cmdlineKnown = !!cmd;
  const isDsh = cmdlineKnown ? pidlook.isDshCmdlineText(cmd) : false;
  const anchors = Array.isArray(o.anchors) ? o.anchors : [];
  let running;
  let identityUnknown = false;
  if (anchors.length && cmdlineKnown) {
    running = matchesAnchors(pid, anchors);
  } else if (anchors.length) {
    
    running = true;
    identityUnknown = true;
  } else if (cmdlineKnown) {
    
    running = isDsh;
  } else {
    
    running = true;
    identityUnknown = true;
  }
  return { pid, running, isDsh, portTaken: true, identityUnknown, phase: running ? 'RUNNING' : 'STOPPED' };
}

module.exports = { probe, probeInstance, isPortListening, matchesAnchors };
