'use strict';

const net = require('node:net');
const pidlook = require('../../platform/os/pidlookup');

async function waitProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidlook.isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function portFree(port) {
  return new Promise((resolve) => {
    let done = false;
    const s = net.createServer();
    const finish = (ok) => { if (done) return; done = true; try { s.close(); } catch {} resolve(ok); };
    s.once('error', () => finish(false));
    s.listen(port, '127.0.0.1', () => finish(true));
  });
}

async function waitPortFree(port, timeoutMs) {
  if (!port) return true;
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (await portFree(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

module.exports = { waitProcessExit, waitPortFree };
