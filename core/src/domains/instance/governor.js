'use strict';

// 资源预算策略（W1/W2）：用户填额废止后，systemd 属性值由「机器预算按活跃实例数等分 + 空闲余量突发」推导。
// decide/allocation/admission 为纯函数（入参 = 机器事实 + 花名册观测）；machineFacts/currentAllocation/budgetSnapshot 是本模块仅有的 IO 触点。

const os = require('node:os');

// 舱可用的物理资源占比；其余留给系统、守卫、壳与回收缓冲。
const HEADROOM = 0.7;
// 单实例下限：低于此值 DSH 的 node 进程无法正常起来，宁可超卖也不发不可用的配额。
const MEM_FLOOR_MB = 512;
// CPUQuota 是硬顶，低于 100% 连单核都推不满；多实例超卖 CPU 可接受（抢占语义），内存不可。
const CPU_FLOOR_PERCENT = 100;
// 实测用量达预留额 0.9 才算有真实需求，进入余量争夺队列。
const BURST_TRIGGER_RATIO = 0.9;
// 单实例最多加一份预留额（memMax 不超过预留 2 倍），防一个实例吞掉全部余量。
const BURST_MAX_MULT = 1;
const MEM_HIGH_RATIO = 0.9; // 先节流后 OOM：MemoryHigh 是真内核节流语义
// 偏离上一生效值 10% 以内不下发、单拍步长不超 25%：防振荡、防对 systemd 写放大。
const DEADBAND = 0.10;
const MAX_STEP = 0.25;
// 连续违规拍数（一拍 = 5s supervise 拍）：内存逼近 OOM 判得快；CPU 可抢占、只是慢化他人，判得慢。
const MEM_VIOLATION_TICKS = 3;
const CPU_VIOLATION_TICKS = 5;

/** 机器事实（唯一默认 IO 读取点）；测试经 opts.machineFacts 注入假值，行为裁决不依赖真机。 */
function machineFacts() {
  return { totalMemBytes: os.totalmem(), cpuCount: os.cpus().length };
}

/** 即将活跃的沙箱实例数（含本实例）：RUNNING/STARTING 计为占用预算。 */
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

/** 'NNNM'/'NNN%' 字符串形态解析回数值（state.allocation 以字符串落盘，纯函数策略按数值计算）。 */
function parseMb(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }
function parsePct(v) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : null; }

/** 等权分配（纯）：总预算按活跃实例数平摊、向下取整、触底走下限，返回 systemd 属性值形态（'NNNM'/'NNN%'）。
 *  启动时刻的保底分配用它，运行期的突发/迟滞调整走 decide()。 */
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

/** 本实例当前应得保底配额（机器事实 + 活数组拓扑；调用点在 lifecycle 启动路径）；facts 为显式注入位，缺省读本机。 */
function currentAllocation(instances, selfId, facts) {
  const f = facts || machineFacts();
  return allocation(f.totalMemBytes, f.cpuCount, activeCount(instances, selfId));
}

/** 迟滞单步（纯）：与上一生效值比，死区内的抖动原样保持；超死区则最多挪 25%。 */
function hysteresis(target, prev) {
  if (prev == null || prev <= 0) return { value: target, changed: true };
  if (Math.abs(target - prev) / prev <= DEADBAND) return { value: prev, changed: false };
  const v = Math.min(Math.round(prev * (1 + MAX_STEP)), Math.max(Math.round(prev * (1 - MAX_STEP)), target));
  return { value: v, changed: v !== prev };
}

/** 每拍决策（纯函数，W2 两段制的本体）。roster 条目 = { id, usageMb, cpuPct, since, prevAlloc, prevTicks }：
 *  usageMb/cpuPct 为 null = 无观测证据：不参与突发、违规计数清零（无证据绝不判违规）；
 *  prevAlloc 取 state.allocation 字符串形态（跨守卫重启保持迟滞基准）。violation 触发即清零计数：处置动作在调用方，事件先于动作。 */
function decide(opt) {
  const roster = (opt && opt.roster) || [];
  const totalMemMb = (opt.totalMemBytes || 0) / (1024 * 1024);
  const budgetMb = totalMemMb * HEADROOM;
  const n = Math.max(1, roster.length);
  const reserveMb = budgetMb / n;
  const cpuTargetPct = Math.max(CPU_FLOOR_PERCENT, Math.floor((opt.cpuCount || 1) * 100 * HEADROOM / n));
  // 突发池 = 物理内存减去舱预算：等分预留下舱内空闲恒为 0，余量只存在于 HEADROOM 留出的舱外。
  let poolLeftMb = totalMemMb - budgetMb;
  const targets = {};
  // 先到先得：按启动时刻升序争夺余量（等权既定裁决：不引入优先级档）。
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
      ticks.mem = 0; // 触发即清零：处置后（退避重启）从头计数，防同一违规连杀多次
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

/** 准入查询（纯）：即将活跃数（含本实例）摊薄后的预留跌破单实例下限即拒绝——
 *  限额废止后没有「用户填的额度」可超卖，下限是唯一不可退让线；绝不静默放行。 */
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

/** 预算总览（/env/status 观测面）：当前花名册占了多少、还剩多少、下一份保底多大。 */
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
    capacity: Math.floor(budgetMb / MEM_FLOOR_MB), // 预算可容纳的下限实例数（面板「还能开几个」）
  };
}

module.exports = {
  HEADROOM, MEM_FLOOR_MB, CPU_FLOOR_PERCENT,
  BURST_TRIGGER_RATIO, BURST_MAX_MULT, MEM_HIGH_RATIO,
  DEADBAND, MAX_STEP, MEM_VIOLATION_TICKS, CPU_VIOLATION_TICKS,
  machineFacts, activeCount, allocation, currentAllocation, hysteresis,
  decide, admission, budgetSnapshot,
};
