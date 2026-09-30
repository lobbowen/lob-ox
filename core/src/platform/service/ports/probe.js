'use strict';

// 端口探测与旧代进程回收（纯 IO）：TCP 连接探测 / bind 探测 / 监听 pid 反查 / cmdline 回收。

const net = require('node:net');
const probe = require('../../util/probe');
const pidlookup = require('../../os/pidlookup');

/** TCP connect 探测：双栈回环任一能连接即视为有进程在监听（见 loopbackListening）。 */
function portListening(port) { return loopbackListening(port); }

/** 双栈回环都探：只连 127.0.0.1 会漏掉 IPv6-only 监听者
 *  （net.ipv6.bindv6only=1 或明确 bind '::1' 的进程）。 */
function loopbackListening(port) {
  const p = Number(port);
  return Promise.all([
    probe.portListening('127.0.0.1', p, 300),
    probe.portListening('::1', p, 300).catch(() => false), // 无 IPv6 栈的主机：连接错误一律视为不可连
  ]).then(([v4, v6]) => v4 || v6);
}

/** bind 探测：回环双栈 + IPv6 any 都可绑定才判「可分配」，任何 bind 错误（EADDRINUSE 等）即不可分配。
 *  除 127.0.0.1/::1 外必须再试 `::`：Linux 非 V6ONLY 的 any 绑定同时占住 v4 端口，只试 specifics 会误判空闲。
 *  剩余 TOCTOU（bind 成功后、消费方 listen 前被抢）无法在探测层根除：登记处有「登记后二次确认、被抢即撤销」
 *  的有界复检（alloc.js），消费方启动仍须按 bind 失败如实报错。 */
function bindable(port) {
  const p = Number(port);
  const bindProbe = (host) => new Promise((resolve) => {
    let done = false;
    const srv = net.createServer();
    const finish = (ok) => { if (done) return; done = true; try { srv.close(); } catch {} resolve(ok); };
    // 环境级失败（无 IPv6 栈：EADDRNOTAVAIL/EAFNOSUPPORT/EINVAL）= 该侧不存在占用者，放行；
    // 端口级失败（EADDRINUSE/EACCES）= 不可分配。缺了这层区分，纯 IPv4 主机会把所有端口判成不可用。
    srv.once('error', (e) => finish(e && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT' || e.code === 'EINVAL')));
    srv.listen(p, host, () => finish(true));
  });
  return (async () => {
    // 必须串行：并发起三个同端口 listen 时，非 V6ONLY 的 `::` 绑定会占住地址通配位，
    // 使 127.0.0.1/::1 探测收到 EADDRINUSE——空闲端口被误判不可分配。
    for (const host of ['127.0.0.1', '::1', '::']) {
      if (!(await bindProbe(host))) return false;
    }
    return true;
  })();
}

/** 按端口反查监听进程 pid；不可得返回 null。 */
function listeningPid(port) {
  try { return pidlookup.findListeningPid(port); } catch { return null; }
}

/** 按 cmdline 特征回收「本工程旧代」进程（YAMA 免疫）；返回终止数。
 *  fail-closed：cmdMark 与 cfgStr 二者皆必填。cfgStr 缺省时过滤条件（`cfg && 不含则跳过`）整条失效，
 *  等价「全部匹配」，pgrepList 命中的任何同名脚本进程（含他人/其它配置的 lan-daemon）会被误杀。 */
function reclaimByCmdMark(cmdMark, cfgStr) {
  if (!cmdMark || !cfgStr) return 0;
  let killed = 0;
  try {
    const cfg = cfgStr;
    for (const m of pidlookup.pgrepList(cmdMark)) {
      const pid = m.pid;
      if (pid === process.pid) continue;
      const cmd = m.cmdline;
      if (cmd.indexOf(cfg) < 0) continue; // cfg 非空已由入口闸保证
      try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
    }
  } catch {}
  return killed;
}

module.exports = { portListening, loopbackListening, bindable, listeningPid, reclaimByCmdMark };
