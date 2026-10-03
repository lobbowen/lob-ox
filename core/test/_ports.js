#!/usr/bin/env node
'use strict';

// 安全段必须同时避开三平台动态端口范围（Linux 32768-60999 / macOS、Windows 49152-65535）与生产池（20000-25999 / 40000-43199）⇒ 上界只能到 32767，取中段 28000-29999。

const BASE = 28000;
// 登记带**绝对上界**（设计约束，硬写整数、不引用 BASE、不由 SEGMENTS 推导）。
// ⚠️ 这一点是判据有效性的关键：若上界由 BASE 或 SEGMENTS 推导，则 BASE 一改判据跟着改
//    ⇒ 判据自证其说、永远不红（已实测两次：先由 SEGMENTS 推导、再由 BASE 推导，突变都不红）。
const BAND_HI = 28300;

const SEGMENTS = {
  'adopt-token-reclaim': 0,
  'api-contract': 1,
  'api-fuzz': 2,
  'daemon-lifecycle': 4,
  'freeze-recovery': 6,
  'frp-resilience': 7,
  'instance-upgrade': 9,
  'lan-daemon': 10,
  'ports-capacity': 12,
  'ports-claim': 13,
  'ports-migrate': 14,
  'ports-verify': 15,
  'precheck': 16,
  'router-e2e': 17,
  'router-test': 27,
  'session-lifecycle': 18,
  'sigterm-desired': 19,
  'smoke': 20,
  'token-boundary': 21,
  'upgrade': 22,
  'shell-watchdog-e2e': 23,
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

// 登记带上界：BASE + 段数 × 10（每段 10 个端口）。登记端口必须落在 [BASE, 上界) 内 ——
// 这是 _ports.js 自己的设计约束；超出即「未经本表登记的裸端口」，与撞动态段同险。
// ⚠️ 此前 isSafe 只排除动态段与生产池 ⇒ BASE 溢出（如 29995）时全部判安全，判据形同虚设（已实测）。
function registrationBand() { return [BASE, BAND_HI]; }

function isSafe(p) {
  const n = Number(p);
  if (!Number.isInteger(n)) return false;
  const [bandLo, bandHi] = registrationBand();
  if (n < bandLo || n >= bandHi) return false;
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

module.exports = { BASE, BAND_HI, SEGMENTS, safeBase, safePort, freePort, isSafe };
