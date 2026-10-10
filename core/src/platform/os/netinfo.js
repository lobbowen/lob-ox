'use strict';

const ex = require('../util/exec');

const PLATFORM = process.platform;

const VIRTUAL_IFACE = /^(virbr|veth|docker|vmnet|br-|lo|vEthernet)/;

function usable(addr) {
  return !!addr && !addr.startsWith('127.') && !addr.startsWith('169.254.');
}

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
    const m = line.match(/^\s+inet\s+([0-9.]+)\s/);
    if (m) records.push({ iface: cur, addr: m[1], dyn: false });
  }
  return pick(records, dev);
}

function win32() {
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
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

function lanAddresses() {
  const fn = IMPL[PLATFORM];
  if (!fn) return [];
  try {
    return [...new Set(fn())];
  } catch {
    return [];
  }
}

module.exports = { lanAddresses, pick, VIRTUAL_IFACE, supported: !!IMPL[PLATFORM], PLATFORM };
