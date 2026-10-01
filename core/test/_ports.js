#!/usr/bin/env node
'use strict';

// 测试专用端口分配。
//   安全段必须同时避开三平台动态端口范围（Linux 32768-60999 / macOS、Windows 49152-65535）
//   与生产池（20000-25999 / 40000-43199）⇒ 上界只能到 32767，取中段 28000-29999。

const BASE = 28000;

// 文件 -> 段序号（每文件 10 个号；新增测试文件在此登记，未登记即报错，避免静默撞号）。
const SEGMENTS = {
  'adopt-token-reclaim': 0,
  'api-contract': 1,
  'api-fuzz': 2,
  'cross-platform': 3,
  'daemon-lifecycle': 4,
  'ensure-instance': 5,
  'freeze-recovery': 6,
  'frp-resilience': 7,
  'guard-update': 8,
  'instance-upgrade': 9,
  'lan-daemon': 10,
  'p2p-router': 11,
  'ports-capacity': 12,
  'ports-claim': 13,
  'ports-migrate': 14,
  'ports-verify': 15,
  'precheck': 16,
  'router-e2e': 17,
  'session-lifecycle': 18,
  'sigterm-desired': 19,
  'smoke': 20,
  'token-boundary': 21,
  'upgrade': 22,
  'shell-watchdog-e2e': 23,
  'defects-batch-f': 24,
  'instance-state': 25,
  'platform-layer-portability': 26,
};

/** 取某测试文件的段基址（未登记则报错 —— 强制登记，避免静默撞号）。 */
function safeBase(name) {
  const seg = SEGMENTS[name];
  if (seg === undefined) {
    throw new Error('未登记的测试段: ' + name + '（请在 test/_ports.js 的 SEGMENTS 中登记）');
  }
  return BASE + seg * 10;
}

/** 某测试文件的第 i 个端口（i 从 0 起）。 */
function safePort(name, i) {
  return safeBase(name) + (i || 0);
}

/** 任一空闲端口（交给 OS 选，最稳）。 */
function freePort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// 各平台动态/临时端口范围（本机 Linux 的实际值会动态读取并叠加）。
const EPHEMERAL_UNION = [
  [32768, 60999],   // Linux 默认 ip_local_port_range
  [49152, 65535],   // macOS / Windows 默认（RFC 6335 Dynamic Ports）
];
const PROD_POOLS = [[20000, 23999], [24000, 25999], [40000, 43199], [41000, 41999], [42000, 42999]];

/** 端口是否安全（不在任何平台的动态范围内，也不在生产池内）。
 *  必须查三平台并集：只按本机（Linux）判断会把 mac/win 危险的 49152-65535 误判为安全。 */
function isSafe(p) {
  const ranges = EPHEMERAL_UNION.slice();
  // 叠加本机实际配置（Linux 可被 sysctl 改为自定义范围）
  try {
    const [lo, hi] = require('node:fs')
      .readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8')
      .trim()
      .split(/\s+/)
      .map(Number);
    if (Number.isFinite(lo) && Number.isFinite(hi)) ranges.push([lo, hi]);
  } catch {}
  for (const [a, b] of ranges) if (p >= a && p <= b) return false;
  for (const [a, b] of PROD_POOLS) if (p >= a && p <= b) return false;
  return true;
}

module.exports = { BASE, SEGMENTS, safeBase, safePort, freePort, isSafe };
