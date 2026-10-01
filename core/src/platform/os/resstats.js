'use strict';

const fs = require('node:fs');
const platform = require('./index');
const ex = require('../util/exec');

const SAMPLE_TIMEOUT_MS = 2000;

function parseProcStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 13) return null;
  const pid = parseInt(text.slice(0, open).trim(), 10);
  const ppid = parseInt(fields[1], 10);
  const cpuMs = (parseInt(fields[11], 10) + parseInt(fields[12], 10)) * 10;
  if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(cpuMs)) return null;
  return { pid, ppid, cpuMs };
}

function parseProcStatusRss(text) {
  const m = /VmRSS:\s+(\d+)\s+kB/.exec(text);
  return m ? parseInt(m[1], 10) * 1024 : null;
}

function parseCpuTimeMs(text) {
  let s = String(text).trim();
  let days = 0;
  const dash = s.indexOf('-');
  if (dash >= 0) { days = parseInt(s.slice(0, dash), 10); s = s.slice(dash + 1); }
  const parts = s.split(':').map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Math.round((days * 86400 + sec) * 1000);
}

function parsePsTable(text) {
  const procs = [];
  for (const line of String(text).split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const pid = parseInt(f[0], 10);
    const ppid = parseInt(f[1], 10);
    const rss = parseInt(f[2], 10);
    const cpuMs = parseCpuTimeMs(f.slice(3).join(' '));
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rss) || cpuMs === null) continue;
    procs.push({ pid, ppid, rssBytes: rss * 1024, cpuMs });
  }
  return procs;
}

// Get-CimInstance Win32_Process 的 JSON：时间单位 100ns，WorkingSetSize 字节。
function parseCimJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(data) ? data : (data ? [data] : []);
  const procs = [];
  for (const r of rows) {
    if (!r) continue;
    const pid = Number(r.ProcessId);
    const ppid = Number(r.ParentProcessId);
    const rss = Number(r.WorkingSetSize);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const cpu100ns = (Number(r.UserModeTime) || 0) + (Number(r.KernelModeTime) || 0);
    procs.push({ pid, ppid, rssBytes: Number.isFinite(rss) ? rss : 0, cpuMs: cpu100ns / 1e4 });
  }
  return procs;
}

function aggregate(rootPid, procs) {
  const byId = new Map();
  const children = new Map();
  for (const p of procs) {
    byId.set(p.pid, p);
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const root = byId.get(rootPid);
  if (!root) return null;
  let rssBytes = 0, cpuMs = 0;
  const stack = [root];
  const seen = new Set([rootPid]);
  while (stack.length) {
    const p = stack.pop();
    rssBytes += p.rssBytes;
    cpuMs += p.cpuMs;
    for (const c of children.get(p.pid) || []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      stack.push(c);
    }
  }
  return { rssBytes, cpuMs };
}

function sampleLinux(pid) {
  let pids;
  try { pids = fs.readdirSync('/proc').filter((s) => /^\d+$/.test(s)); } catch { return null; }
  const procs = [];
  for (const s of pids) {
    let stat = null;
    try { stat = fs.readFileSync('/proc/' + s + '/stat', 'utf8'); } catch { continue; }
    const p = parseProcStat(stat);
    if (!p) continue;
    let rss = null;
    try { rss = parseProcStatusRss(fs.readFileSync('/proc/' + s + '/status', 'utf8')); } catch {}
    procs.push({ pid: p.pid, ppid: p.ppid, rssBytes: rss || 0, cpuMs: p.cpuMs });
  }
  return aggregate(pid, procs);
}

const CIM_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,' +
  'WorkingSetSize,UserModeTime,KernelModeTime | ConvertTo-Json -Compress';

function sampleAsync(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  if (platform.isLinux) return Promise.resolve(sampleLinux(pid));
  if (platform.isMac) {
    return ex.runOutAsync('ps', ['-axo', 'pid=,ppid=,rss=,cputime='], { timeoutMs: SAMPLE_TIMEOUT_MS })
      .then((t) => (t === null ? null : aggregate(pid, parsePsTable(t))));
  }
  if (platform.isWindows) {
    return ex.runOutAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CIM_QUERY], { timeoutMs: SAMPLE_TIMEOUT_MS })
      .then((t) => (t === null ? null : aggregate(pid, parseCimJson(t))));
  }
  return Promise.resolve(null);
}

module.exports = {
  sampleAsync, aggregate,
  _parse: { parseProcStat, parseProcStatusRss, parseCpuTimeMs, parsePsTable, parseCimJson },
};
