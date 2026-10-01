'use strict';

const net = require('node:net');
const probe = require('../../util/probe');
const pidlookup = require('../../os/pidlookup');

function portListening(port) { return loopbackListening(port); }

function loopbackListening(port) {
  const p = Number(port);
  return Promise.all([
    probe.portListening('127.0.0.1', p, 300),
    probe.portListening('::1', p, 300).catch(() => false),
  ]).then(([v4, v6]) => v4 || v6);
}

// 除 127.0.0.1/::1 外必须再试 ::（Linux 非 V6ONLY 的 any 绑定会同时占住 v4），任何 bind 错误即不可分配；剩余 TOCTOU 由 alloc 复检层兜。
function bindable(port) {
  const p = Number(port);
  const bindProbe = (host) => new Promise((resolve) => {
    let done = false;
    const srv = net.createServer();
    const finish = (ok) => { if (done) return; done = true; try { srv.close(); } catch {} resolve(ok); };
    srv.once('error', (e) => finish(e && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT' || e.code === 'EINVAL')));
    srv.listen(p, host, () => finish(true));
  });
  return (async () => {
    for (const host of ['127.0.0.1', '::1', '::']) {
      if (!(await bindProbe(host))) return false;
    }
    return true;
  })();
}

function listeningPid(port) {
  try { return pidlookup.findListeningPid(port); } catch { return null; }
}

// fail-closed：cmdMark 与 cfgStr 皆必填；cfgStr 缺省会让过滤整条失效 = 匹配全部同名脚本进程（会误杀他人 daemon）。
function reclaimByCmdMark(cmdMark, cfgStr) {
  if (!cmdMark || !cfgStr) return 0;
  let killed = 0;
  try {
    const cfg = cfgStr;
    for (const m of pidlookup.pgrepList(cmdMark)) {
      const pid = m.pid;
      if (pid === process.pid) continue;
      const cmd = m.cmdline;
      if (cmd.indexOf(cfg) < 0) continue;
      try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
    }
  } catch {}
  return killed;
}

module.exports = { portListening, loopbackListening, bindable, listeningPid, reclaimByCmdMark };
