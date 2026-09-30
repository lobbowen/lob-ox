'use strict';

// app/daemons/process-wait.js —— 受管 daemon 的等待原语（IO：轮询 / 端口 bind 探测）。
// 无 this、无状态，全部为具名 async 函数，依赖显式入参。

const net = require('node:net');
const pidlook = require('../../platform/os/pidlookup');

/** 轮询等待：某 pid 进程真正消失（/proc 确认）。 */
async function waitProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidlook.isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 轮询等待：端口可绑（无监听者）——用 bind 探测（与真实监听语义一致，见 platform/service/ports.js）。 */
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
