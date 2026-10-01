#!/usr/bin/env node
'use strict';

// 安全段必须同时避开三平台动态端口范围（Linux 32768-60999 / macOS、Windows 49152-65535）与生产池（20000-25999 / 40000-43199）⇒ 上界只能到 32767，取中段 28000-29999。

const BASE = 28000;

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

// 未登记的测试文件取段直接报错 —— 强制登记，避免静默撞号。
function safeBase(name) {
  const seg = SEGMENTS[name];
  if (seg === undefined) {
    throw new Error('未登记的测试段: ' + name + '（请在 test/_ports.js 的 SEGMENTS 中登记）');
  }
  return BASE + seg * 10;
}

function safePort(name, i) {
  return safeBase(name) + (i || 0);
}

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

const EPHEMERAL_UNION = [
  [32768, 60999],   // Linux 默认 ip_local_port_range
  [49152, 65535],   // macOS / Windows 默认（RFC 6335 Dynamic Ports）
];
const PROD_POOLS = [[20000, 23999], [24000, 25999], [40000, 43199], [41000, 41999], [42000, 42999]];

function isSafe(p) {
  const ranges = EPHEMERAL_UNION.slice();
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
