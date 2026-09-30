'use strict';

// 本机局域网可访问地址枚举：三端各用自己的命令（linux: ip route / ip -o addr；darwin: route -n get
// default + ifconfig；win32: PowerShell Get-NetRoute / Get-NetIPAddress），不得用单平台专有命令糊弄其余两端。
// 统一语义：只报局域网内真正可达的 IPv4 —— 默认路由的真实出口网卡优先，过滤虚拟网卡（VIRTUAL_IFACE）
// 与回环/链路本地，同网卡静态地址优先。外部命令一律经 platform/util/exec（15s 硬超时 + SIGKILL）。

const ex = require('../util/exec');

const PLATFORM = process.platform;

const VIRTUAL_IFACE = /^(virbr|veth|docker|vmnet|br-|lo|vEthernet)/;

function usable(addr) {
  return !!addr && !addr.startsWith('127.') && !addr.startsWith('169.254.');
}

/** 从 (iface, addr, dyn) 记录里挑地址：默认路由网卡优先，同网卡静态优先。 */
function pick(records, dev) {
  const byIface = {};
  for (const r of records) {
    if (!usable(r.addr)) continue;
    if (VIRTUAL_IFACE.test(r.iface)) continue;
    (byIface[r.iface] = byIface[r.iface] || []).push(r);
  }
  const firstOf = (arr) => {
    const stat = arr.find((x) => !x.dyn);
    return (stat || arr[0]).addr;
  };
  const out = [];
  if (dev && byIface[dev]) { out.push(firstOf(byIface[dev])); delete byIface[dev]; }
  for (const iface of Object.keys(byIface)) out.push(firstOf(byIface[iface]));
  return out;
}

function linux() {
  let dev = null;
  const def = ex.runOut('ip', ['route', 'show', 'default']);
  if (def) dev = (def.match(/dev\s+(\S+)/) || [])[1] || null;
  const out = ex.runOut('ip', ['-o', 'addr', 'show']);
  if (!out) return [];
  const records = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\d+:\s+(\S+?)(@\S+)?\s+inet\s+([0-9.]+)\//);
    if (!m) continue;
    records.push({ iface: m[1], addr: m[3], dyn: /(?:secondary|dynamic)/.test(line) });
  }
  return pick(records, dev);
}

function darwin() {
  let dev = null;
  const def = ex.runOut('route', ['-n', 'get', 'default']);
  if (def) dev = (def.match(/interface:\s*(\S+)/) || [])[1] || null;
  const out = ex.runOut('ifconfig');
  if (!out) return [];
  const records = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const iface = line.match(/^(\S+):\s+flags=/);
    if (iface) { cur = iface[1]; continue; }
    if (!cur) continue;
    // macOS ifconfig 的 IPv4 行形如 `\tinet 192.168.1.5 netmask 0xffffff00 broadcast ...`
    const m = line.match(/^\s+inet\s+([0-9.]+)\s/);
    if (m) records.push({ iface: cur, addr: m[1], dyn: false });
  }
  return pick(records, dev);
}

/* Windows：PowerShell（JSON 输出，避免解析本地化文本） */
function win32() {
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
    // 默认路由的接口名（等价于 Linux 的 dev）
    '$def = (Get-NetRoute -DestinationPrefix "0.0.0.0/0" | Sort-Object RouteMetric | Select-Object -First 1).InterfaceAlias',
    '$rows = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } | ForEach-Object { [PSCustomObject]@{ iface = $_.InterfaceAlias; addr = $_.IPAddress; isDef = ($_.InterfaceAlias -eq $def) } }',
    'ConvertTo-Json -InputObject @($rows) -Compress',
  ].join('; ');
  const out = ex.runOut('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (!out || !out.trim()) return [];
  let arr;
  try {
    const j = JSON.parse(out.trim());
    arr = Array.isArray(j) ? j : [j];
  } catch { return []; }
  const records = arr
    .filter((r) => r && r.addr)
    .map((r) => ({ iface: String(r.iface || ''), addr: String(r.addr), dyn: false }));
  const defRow = arr.find((r) => r && r.isDef);
  return pick(records, defRow ? String(defRow.iface || '') : null);
}

const IMPL = { linux, darwin, win32 };

/** 已去重的地址列表；任何平台都不抛异常，取不到就返回空数组（调用方展示「无可用地址」）。 */
function lanAddresses() {
  const fn = IMPL[PLATFORM];
  if (!fn) return []; // 未知平台
  try {
    return [...new Set(fn())];
  } catch {
    return [];
  }
}

module.exports = { lanAddresses, pick, VIRTUAL_IFACE, supported: !!IMPL[PLATFORM], PLATFORM };
