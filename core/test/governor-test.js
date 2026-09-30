#!/usr/bin/env node
'use strict';

// 资源预算策略（governor）行为测试：activeCount 拓扑计数、allocation 平摊/下限/单调性、decide 两段制
// （突发/先到先得/迟滞/违规处置）、admission 准入、budgetSnapshot 总览。独立脚本：node test/governor-test.js。
// 判据只断**外部行为与区间**：公式常量取值与簿记字段（changed/ticks）属实现选择，不在此锁定。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { HEADROOM, MEM_FLOOR_MB, CPU_FLOOR_PERCENT, activeCount, allocation, currentAllocation, decide, admission, budgetSnapshot } = require(path.join(ROOT, 'src', 'domains', 'instance', 'governor'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };
const GiB = (g) => g * 1024 * 1024 * 1024;
const memNum = (a) => parseInt(a.memoryMax, 10);
const cpuNum = (a) => parseInt(a.cpuQuota, 10);

// -- G1 activeCount：只计 sandbox 域 RUNNING/STARTING；自不在账上则 +1 --
console.log('== G1 activeCount 拓扑计数 ==');
{
  const mk = (id, domain, phase) => ({ id, domain, state: { phase } });
  check('G1 空列表/缺省 instances → 1（新起实例自身占一格），自身已 RUNNING 不重复计', activeCount([], 'a') === 1 && activeCount(undefined, 'a') === 1 && activeCount([mk('a', 'sandbox', 'RUNNING')], 'a') === 1, '');
  check('G1 活跃相位（RUNNING/STARTING）他实例计占用、自实例不重复计；非活跃相位（BACKOFF/FAILED/STOPPED）不计',
    activeCount([mk('b', 'sandbox', 'RUNNING'), mk('a', 'sandbox', 'STOPPED')], 'a') === 2 && activeCount([mk('b', 'sandbox', 'STARTING')], 'a') === 2
    && activeCount([mk('b', 'sandbox', 'BACKOFF'), mk('c', 'sandbox', 'FAILED')], 'a') === 1, '');
  check('G1 native 域不计（限额只发给沙箱单元）；state 缺失的脏记录不计且不抛',
    activeCount([mk('n', 'native', 'RUNNING'), mk('b', 'sandbox', 'RUNNING')], 'a') === 2 && activeCount([{ id: 'x', domain: 'sandbox' }], 'a') === 1, '');
}

// -- G2 allocation：等权平摊、触底走下限、单调不增 --
console.log('== G2 allocation 平摊与下限 ==');
{
  const M = GiB(16), budgetMb = Math.floor((M * HEADROOM) / (1024 * 1024));
  const a1 = allocation(M, 8, 1), a2 = allocation(M, 8, 2), big = allocation(M, 8, 64);
  check('G2 策略常量在合理区间（0<headroom<1、内存下限≥256M、CPU 下限>0）且单实例份额落在 (下限, 总预算] 内', HEADROOM > 0 && HEADROOM < 1 && MEM_FLOOR_MB >= 256 && CPU_FLOOR_PERCENT > 0 && memNum(a1) > MEM_FLOOR_MB && memNum(a1) <= budgetMb, 'HEADROOM=' + HEADROOM + ' 下限=' + MEM_FLOOR_MB + 'M/' + CPU_FLOOR_PERCENT + '% ' + a1.memoryMax);
  check('G2 双实例等权平摊：两者相等、各约为单实例份额的一半（CPU 份额 >0）', memNum(a2) === memNum(allocation(M, 8, 2)) && Math.abs(memNum(a2) * 2 - memNum(a1)) <= 2 && cpuNum(a2) > 0, a2.memoryMax + ' ' + a2.cpuQuota);
  check('G2 触底走下限：实例数极大时内存不低于下限且不超单实例份额、CPU 不低于下限', memNum(big) >= MEM_FLOOR_MB && memNum(big) <= memNum(a1) && cpuNum(big) >= CPU_FLOOR_PERCENT, big.memoryMax + ' ' + big.cpuQuota);
  let mono = true;
  for (let n = 1; n < 16; n++) if (memNum(allocation(M, 8, n + 1)) > memNum(allocation(M, 8, n))) mono = false;
  check('G2 单调性：实例数增 → 单实例内存配额不增，且 n=0 兜底为 n=1', mono && allocation(M, 8, 0).memoryMax === a1.memoryMax, '');
  check('G2 MemoryHigh 严格低于 MemoryMax 且同量级（回收节流先于 OOM）', memNum(a1) > parseInt(a1.memoryHigh, 10) && parseInt(a1.memoryHigh, 10) >= Math.floor(memNum(a1) * 0.85), a1.memoryMax + ' / ' + a1.memoryHigh);
}

// -- G3 currentAllocation：唯一 IO 触点，只断机器事实形态与下限 --
console.log('== G3 currentAllocation 形态 ==');
{
  const solo = currentAllocation([], 'fresh');
  const busy = currentAllocation([{ id: 'b', domain: 'sandbox', state: { phase: 'RUNNING' } }], 'fresh');
  check('G3 输出为 systemd 属性值形态（内存 NNNM / CPU NNN%）且不低于下限', /^\d+M$/.test(solo.memoryMax) && /^\d+%$/.test(solo.cpuQuota) && memNum(solo) >= MEM_FLOOR_MB && cpuNum(solo) >= CPU_FLOOR_PERCENT, solo.memoryMax + ' ' + solo.cpuQuota);
  check('G3 已有活跃实例 → 本实例内存与 CPU 份额均不增', memNum(busy) <= memNum(solo) && cpuNum(busy) <= cpuNum(solo), busy.memoryMax + ' vs ' + solo.memoryMax);
}

// -- G4 decide 两段制：预留 + 突发（先到先得、封顶 2x 预留）+ 迟滞 + 违规处置 --
console.log('== G4 decide 两段制与违规矩阵 ==');
{
  const M = GiB(16), R = (id, extra) => Object.assign({ id, usageMb: null, cpuPct: null, since: 0, prevAlloc: null, prevTicks: null }, extra || {}), byId = (plan, id) => plan.entries.find((e) => e.id === id);
  const solo = allocation(M, 8, 1), duo = allocation(M, 8, 2), quart = allocation(M, 8, 4);
  const d2 = decide({ totalMemBytes: M, cpuCount: 8, roster: [R('a'), R('b')] });
  check('G4 双实例闲置 = 等权预留（与 allocation 同源、低于单实例份额）', byId(d2, 'a').alloc.memoryMax === duo.memoryMax && memNum(byId(d2, 'a').alloc) < memNum(solo), byId(d2, 'a').alloc.memoryMax);
  const d3 = decide({ totalMemBytes: M, cpuCount: 8, roster: [R('a', { usageMb: 6000, since: 1 }), R('b', { usageMb: 100, since: 2 })] });
  check('G4 有需求实例获突发补差（超预留、不超 2x 预留），闲置者拿纯预留', byId(d3, 'a').memoryMaxMb > memNum(duo) && byId(d3, 'a').memoryMaxMb <= 2 * memNum(duo) && byId(d3, 'b').memoryMaxMb === memNum(duo), byId(d3, 'a').memoryMaxMb + ' / ' + byId(d3, 'b').memoryMaxMb);
  const d4 = decide({ totalMemBytes: M, cpuCount: 8, roster: [R('a', { usageMb: 30000, since: 1 }), R('b', { usageMb: 30000, since: 2 })] });
  check('G4 先到先得：先起者不低于后到者，池耗尽后到者回落纯预留', byId(d4, 'a').memoryMaxMb > memNum(duo) && byId(d4, 'a').memoryMaxMb >= byId(d4, 'b').memoryMaxMb && byId(d4, 'b').memoryMaxMb === memNum(duo), byId(d4, 'a').memoryMaxMb + ' / ' + byId(d4, 'b').memoryMaxMb);
  const d5 = decide({ totalMemBytes: M, cpuCount: 8, roster: [R('a', { usageMb: 6000, since: 1 }), R('b', { usageMb: 6000, since: 2 }), R('c', { usageMb: 100, since: 3 }), R('d', { usageMb: 100, since: 4 })] });
  check('G4 突发封顶 2x 预留、池余量补给第二需求者、闲置实例纯预留不受挤压', byId(d5, 'a').memoryMaxMb <= 2 * memNum(quart) && byId(d5, 'a').memoryMaxMb > memNum(quart) && byId(d5, 'b').memoryMaxMb > memNum(quart) && byId(d5, 'b').memoryMaxMb <= byId(d5, 'a').memoryMaxMb && byId(d5, 'c').memoryMaxMb === memNum(quart), [byId(d5, 'a').memoryMaxMb, byId(d5, 'b').memoryMaxMb, byId(d5, 'c').memoryMaxMb].join(' / '));
  // 迟滞步长只断区间（不一步到位、也不原地不动），不锁单拍步长这一实现选择。
  const h1 = decide({ totalMemBytes: M, cpuCount: 8, roster: [R('a', { prevAlloc: { memoryMax: duo.memoryMax, cpuQuota: duo.cpuQuota } })] });
  const h2 = decide({ totalMemBytes: M, cpuCount: 8, roster: [R('a', { prevAlloc: { memoryMax: '5300M', cpuQuota: '280%' } }), R('b')] });
  check('G4 迟滞：目标翻倍时单拍只挪一部分（落在上一生效值与全额之间）；偏离小于阈值则保持上一生效值不抖动', byId(h1, 'a').memoryMaxMb > memNum(duo) && byId(h1, 'a').memoryMaxMb < memNum(solo) && byId(h2, 'a').memoryMaxMb === 5300, byId(h1, 'a').memoryMaxMb + ' / ' + byId(h2, 'a').memoryMaxMb);
  const P = (extra) => R('a', Object.assign({ prevAlloc: { memoryMax: solo.memoryMax, cpuQuota: solo.cpuQuota } }, extra));
  const v1 = decide({ totalMemBytes: M, cpuCount: 8, roster: [P({ usageMb: 30000, prevTicks: { mem: 2, cpu: 0 } })] });
  const v2 = decide({ totalMemBytes: M, cpuCount: 8, roster: [P({ usageMb: 30000, prevTicks: { mem: 1, cpu: 0 } })] });
  check('G4 内存连续超限达阈值 -> memory 违规且新限额高于原份额、不超 2x 预留；未达阈值不处置', !!byId(v1, 'a').violation && byId(v1, 'a').violation.kind === 'memory' && byId(v1, 'a').violation.target > memNum(solo) && byId(v1, 'a').violation.target <= 2 * memNum(solo) && byId(v2, 'a').violation === null, JSON.stringify(byId(v1, 'a').violation));
  const v3 = decide({ totalMemBytes: M, cpuCount: 8, roster: [P({ usageMb: 1000, cpuPct: 600, prevTicks: { mem: 2, cpu: 4 } })] });
  const v4 = decide({ totalMemBytes: M, cpuCount: 8, roster: [P({ usageMb: 30000, cpuPct: 600, prevTicks: { mem: 2, cpu: 4 } })] });
  check('G4 CPU 连续超限达阈值 -> cpu 违规；双违规同拍内存优先（OOM 风险大于慢化）', !!byId(v3, 'a').violation && byId(v3, 'a').violation.kind === 'cpu' && byId(v4, 'a').violation.kind === 'memory', JSON.stringify(byId(v3, 'a').violation) + ' | ' + JSON.stringify(byId(v4, 'a').violation));
  check('G4 空/无证据花名册 -> 零条目不抛且不误伤闲置实例', decide({ totalMemBytes: M, cpuCount: 8, roster: [] }).entries.length === 0 && decide({ totalMemBytes: M, cpuCount: 8, roster: [R('a')] }).entries[0].violation === null, '');
}

// -- G5 admission 准入：等分后跌破单实例下限即显式拒绝（绝不静默超卖） --
console.log('== G5 admission 准入矩阵 ==');
{
  const M = GiB(16), cap = Math.floor(M * HEADROOM / (1024 * 1024) / MEM_FLOOR_MB);
  const mkRun = (id) => ({ id, domain: 'sandbox', state: { phase: 'RUNNING', allocation: { memoryMax: MEM_FLOOR_MB + 'M' } } });
  const rej = admission(Array.from({ length: cap }, (_, k) => mkRun('r' + k)), 'x', M);
  check('G5 预算容量内（末位仍够下限）放行、容量耗尽显式拒绝且带可读原因（绝不静默超卖）', admission(Array.from({ length: cap - 1 }, (_, k) => mkRun('r' + k)), 'x', M).ok === true && rej.ok === false && !!rej.error, 'cap=' + cap + ' ' + rej.error);
  check('G5 自身已 RUNNING 不重复计数、native 实例不占沙箱预算', admission([mkRun('x')], 'x', M).ok === true && admission([mkRun('r0'), { id: 'n', domain: 'native', state: { phase: 'RUNNING' } }], 'x', M).ok === true, '');
}

// -- G6 budgetSnapshot 预算总览（/env/status 观测面） --
console.log('== G6 budgetSnapshot 总览 ==');
{
  const facts = { totalMemBytes: GiB(16), cpuCount: 8 };
  const inst = (id, phase) => ({ id, domain: 'sandbox', state: { phase, allocation: { memoryMax: '4096M', cpuQuota: '100%' } } });
  const s = budgetSnapshot([inst('a', 'RUNNING'), inst('b', 'STARTING'), inst('c', 'STOPPED')], facts);
  check('G6 总预算落在 (0, 物理内存] 内；只计活跃实例占用（STOPPED 的不算）', s.budgetMb > 0 && s.budgetMb <= GiB(16) / (1024 * 1024) && s.activeCount === 2 && s.usedMb > 0 && s.usedMb <= s.budgetMb, String(s.budgetMb) + ' ' + s.activeCount + '/' + s.usedMb);
  check('G6 下一份保底摊薄在 (0, 总预算] 内、容量 >= 1；空花名册不抛且容量可用', s.reservationMb > 0 && s.reservationMb <= s.budgetMb && s.capacity >= 1 && budgetSnapshot([], facts).usedMb === 0 && budgetSnapshot(undefined, facts).activeCount === 0, s.reservationMb + ' / ' + s.capacity);
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
