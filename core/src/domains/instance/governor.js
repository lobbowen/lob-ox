'use strict';

const os = require('node:os');

const HEADROOM = 0.7;
const MEM_FLOOR_MB = 512;
const CPU_FLOOR_PERCENT = 100;
const BURST_TRIGGER_RATIO = 0.9;
const BURST_MAX_MULT = 1;
const MEM_HIGH_RATIO = 0.9;
// 偏离上一生效值 10% 内不下发、单拍步长不超 25%：防振荡、防对 systemd 写放大。
const DEADBAND = 0.10;
const MAX_STEP = 0.25;
const MEM_VIOLATION_TICKS = 3;
const CPU_VIOLATION_TICKS = 5;

function machineFacts() {
  return { totalMemBytes: os.totalmem(), cpuCount: os.cpus().length };
}

function activeCount(instances, selfId) {
  let n = 0;
  let self = false;
  for (const i of instances || []) {
    if (i.domain !== 'sandbox') continue;
    const phase = i.state && i.state.phase;
    if (phase === 'RUNNING' || phase === 'STARTING') {
      n += 1;
      if (i.id === selfId) self = true;
    }
  }
  return self ? n : n + 1;
}

function parseMb(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }
function parsePct(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }

function allocation(totalMemBytes, cpuCount, n) {
  const k = Math.max(1, n);
  const memMb = Math.max(MEM_FLOOR_MB, Math.round((totalMemBytes * HEADROOM) / k / (1024 * 1024)));
  const cpuPct = Math.max(CPU_FLOOR_PERCENT, Math.floor((cpuCount * 100 * HEADROOM) / k));
  return {
    memoryMax: memMb + 'M',
    memoryHigh: Math.round(memMb * MEM_HIGH_RATIO) + 'M',
    cpuQuota: cpuPct + '%',
  };
}

function currentAllocation(instances, selfId, facts) {
  const f = facts || machineFacts();
  return allocation(f.totalMemBytes, f.cpuCount, activeCount(instances, selfId));
}

function hysteresis(target, prev) {
  if (prev == null || prev <= 0) return { value: target, changed: true };
  if (Math.abs(target - prev) / prev <= DEADBAND) return { value: prev, changed: false };
  const v = Math.min(Math.round(prev * (1 + MAX_STEP)), Math.max(Math.round(prev * (1 - MAX_STEP)), target));
  return { value: v, changed: v !== prev };
}

function decide(opt) {
  const roster = (opt && opt.roster) || [];
  const totalMemMb = (opt.totalMemBytes || 0) / (1024 * 1024);
  const budgetMb = totalMemMb * HEADROOM;
  const n = Math.max(1, roster.length);
  const reserveMb = budgetMb / n;
  const cpuTargetPct = Math.max(CPU_FLOOR_PERCENT, Math.floor((opt.cpuCount || 1) * 100 * HEADROOM / n));
  let poolLeftMb = totalMemMb - budgetMb;
  const targets = {};
  const order = roster.slice().sort((a, b) => (a.since || 0) - (b.since || 0));
  for (const r of order) {
    let burst = 0;
    if (typeof r.usageMb === 'number' && r.usageMb >= reserveMb * BURST_TRIGGER_RATIO) {
      burst = Math.max(0, Math.min(r.usageMb - reserveMb, reserveMb * BURST_MAX_MULT, poolLeftMb));
      poolLeftMb -= burst;
    }
    targets[r.id] = Math.max(MEM_FLOOR_MB, Math.round(reserveMb + burst));
  }
  const entries = [];
  for (const r of roster) {
    const prevAlloc = r.prevAlloc || {};
    const prevTicks = r.prevTicks || {};
    const mem = hysteresis(targets[r.id], parseMb(prevAlloc.memoryMax));
    const cpu = hysteresis(cpuTargetPct, parsePct(prevAlloc.cpuQuota));
    const ticks = {
      mem: (typeof r.usageMb === 'number' && r.usageMb > mem.value) ? (prevTicks.mem || 0) + 1 : 0,
      cpu: (typeof r.cpuPct === 'number' && r.cpuPct > cpu.value) ? (prevTicks.cpu || 0) + 1 : 0,
    };
    let violation = null;
    if (ticks.mem >= MEM_VIOLATION_TICKS) {
      violation = { kind: 'memory', actual: r.usageMb, target: mem.value };
      ticks.mem = 0;
    } else if (ticks.cpu >= CPU_VIOLATION_TICKS) {
      violation = { kind: 'cpu', actual: r.cpuPct, target: cpu.value };
      ticks.cpu = 0;
    }
    entries.push({
      id: r.id,
      alloc: {
        memoryMax: mem.value + 'M',
        memoryHigh: Math.round(mem.value * MEM_HIGH_RATIO) + 'M',
        cpuQuota: cpu.value + '%',
      },
      memoryMaxMb: mem.value,
      cpuQuotaPct: cpu.value,
      changed: mem.changed || cpu.changed,
      ticks,
      violation,
    });
  }
  return {
    entries,
    reserveMb: Math.round(reserveMb),
    burstUsedMb: Math.round((totalMemMb - budgetMb) - poolLeftMb),
  };
}

function admission(instances, selfId, totalMemBytes) {
  const n = activeCount(instances, selfId);
  const budgetMb = (totalMemBytes || 0) * HEADROOM / (1024 * 1024);
  if (budgetMb / n >= MEM_FLOOR_MB) return { ok: true, count: n, budgetMb: Math.round(budgetMb) };
  let usedMb = 0;
  for (const i of instances || []) {
    if (i.domain !== 'sandbox') continue;
    const phase = i.state && i.state.phase;
    if (phase !== 'RUNNING' && phase !== 'STARTING') continue;
    usedMb += (i.state && i.state.allocation && parseMb(i.state.allocation.memoryMax)) || 0;
  }
  return {
    ok: false,
    count: n,
    budgetMb: Math.round(budgetMb),
    usedMb: Math.round(usedMb),
    error: '预算已满：' + (n - 1) + ' 实例已预留 ' + Math.round(usedMb) + '/' + Math.round(budgetMb) +
      'MB，新实例保底 ' + MEM_FLOOR_MB + 'MB 无法容纳，停一个或等待释放',
  };
}

function budgetSnapshot(instances, facts) {
  const f = facts || machineFacts();
  const totalMemMb = Math.round(f.totalMemBytes / (1024 * 1024));
  const budgetMb = Math.round(totalMemMb * HEADROOM);
  let active = 0, usedMb = 0, cpuUsedPct = 0;
  for (const i of instances || []) {
    if (i.domain !== 'sandbox') continue;
    const phase = i.state && i.state.phase;
    if (phase !== 'RUNNING' && phase !== 'STARTING') continue;
    active += 1;
    const alloc = (i.state && i.state.allocation) || {};
    usedMb += parseMb(alloc.memoryMax) || 0;
    cpuUsedPct += parsePct(alloc.cpuQuota) || 0;
  }
  return {
    headroom: HEADROOM,
    memFloorMb: MEM_FLOOR_MB,
    totalMemMb,
    budgetMb,
    usedMb: Math.round(usedMb),
    activeCount: active,
    reservationMb: Math.round(budgetMb / Math.max(1, active)),
    cpuCount: f.cpuCount,
    cpuBudgetPct: Math.round(f.cpuCount * 100 * HEADROOM),
    cpuUsedPct: Math.round(cpuUsedPct),
    capacity: Math.floor(budgetMb / MEM_FLOOR_MB),
  };
}

module.exports = {
  HEADROOM, MEM_FLOOR_MB, CPU_FLOOR_PERCENT,
  BURST_TRIGGER_RATIO, BURST_MAX_MULT, MEM_HIGH_RATIO,
  DEADBAND, MAX_STEP, MEM_VIOLATION_TICKS, CPU_VIOLATION_TICKS,
  machineFacts, activeCount, allocation, currentAllocation, hysteresis,
  decide, admission, budgetSnapshot,
};
