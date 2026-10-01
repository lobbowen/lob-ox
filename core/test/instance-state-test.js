#!/usr/bin/env node
'use strict';

// 沙箱实例状态机与监督拍行为（state-machine.js 纯转移 + 守护语义 + 控制面接线）：
//   restartCount 稳定窗归零与 20 次上限 FAILED 语义；第 7 节验 govern tick（观测->决策->下发/处置）
//   与准入（预算摊薄跌破下限显式拒绝）。域改造后状态转移是**纯函数**，只 require 叶子模块 + 假依赖。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const sm = require(path.join(ROOT, 'src', 'domains', 'instance', 'state-machine'));
const sandbox = require(path.join(ROOT, 'src', 'domains', 'instance', 'sandbox'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
let saves = 0;
const deps = {
  events: { append() {} },
  logger: { info() {}, warn() {}, error() {} },
  save() { saves++; },
  tokens: null,
};
function makeInst() {
  return { id: 't1', name: '测试', domain: 'sandbox', state: { phase: 'STOPPED', restartCount: 0, backoffLevel: 0, lastProbeOk: null } };
}
const now = Date.now();

// 1. restart 累计 + 退避
const i1 = makeInst();
sm.restart(deps, i1, '启动失败');
check('restart: 进入 BACKOFF、计数 +1 且已设退避恢复点',
  i1.state.phase === 'BACKOFF' && i1.state.restartCount === 1 && Number.isFinite(i1.state.backoffUntil)
  && i1.state.backoffUntil >= now + 5000, JSON.stringify(i1.state));

// 2. 稳定运行后 restartCount 归零（5min 窗）
const i2 = makeInst();
i2.state.restartCount = 3; i2.state.backoffLevel = 2; i2.state.lastFailAt = now - 6 * 60 * 1000; // 6 分钟前失败
sm.setRunning(deps, i2, { pid: 123 }, now);
check('稳定窗(>5min)后 restartCount/backoffLevel 归零且 phase=RUNNING',
  i2.state.restartCount === 0 && i2.state.backoffLevel === 0 && i2.state.phase === 'RUNNING', JSON.stringify(i2.state));

// 3. 短期内多次重启不清零（<5min 窗）
const i3 = makeInst();
i3.state.restartCount = 3; i3.state.backoffLevel = 1; i3.state.lastFailAt = now - 60 * 1000;
sm.setRunning(deps, i3, { pid: 456 }, now);
check('未过稳定窗(<5min) restartCount 保留', i3.state.restartCount === 3 && i3.state.backoffLevel === 1, JSON.stringify(i3.state));

// 4. 重试上限（attempts > 20，即第 21 次判定）-> FAILED；恰 20 次仍在退避（不越界）
const i4 = makeInst();
for (let k = 0; k < 21; k++) sm.restart(deps, i4, '崩溃' + k);
const i4b = makeInst();
for (let k = 0; k < 20; k++) sm.restart(deps, i4b, '崩溃' + k);
check('重试上限：第 21 次 → FAILED（重试超限），恰 20 次仍 BACKOFF',
  i4.state.phase === 'FAILED' && /重试超限/.test(i4.state.lastError || '')
  && i4b.state.phase === 'BACKOFF' && i4b.state.restartCount === 20,
  i4.state.phase + ' / ' + i4b.state.phase + ' count=' + i4b.state.restartCount);

// 5. fail / setStopped
const i5 = makeInst();
sm.fail(deps, i5, '安装失败');
check('failInstance → FAILED + reason', i5.state.phase === 'FAILED' && i5.state.lastError === '安装失败', JSON.stringify(i5.state));
const i6 = makeInst();
sm.setStopped(deps, i6);
check('setStopped → STOPPED', i6.state.phase === 'STOPPED', i6.state.phase);
check('副作用经 deps.save 显式发出（非隐式 this）', saves > 0, 'saves=' + saves);

// -- 6. 守护开关必须约束 BACKOFF/FAILED 的自愈拉起 --
//    supervise 是域级行为：用可注入假 service + 临时目录构造 InstanceManager，
//    端口取 0（pidlookup 必不命中）-> 探测恒「未运行」，绝不触碰真实 systemd/进程。
(async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance'));
  const mk = (phase, extra) => Object.assign({
    id: 'b15', name: 'B15', domain: 'sandbox', port: 0, guardian: false,
    state: Object.assign({ phase, restartCount: 2, backoffLevel: 1, lastProbeOk: false }, extra || {}),
  }, {});
  const svcCalls = [];
  const fakeService = {
    daemonReload() { svcCalls.push('daemonReload'); return true; },
    stopUnit() { svcCalls.push('stopUnit'); return true; }, resetFailed() { return true; },
    isUnitActive() { return false; }, transientUnitFile() { return null; }, cleanTransient() {},
    startTransient() { svcCalls.push('startTransient'); return true; },
  };
  const mkMgr = (tmp, svcOverride) => {
    const mgr = new InstanceManager({
      dir: tmp, logger: { info() {}, warn() {}, error() {} }, service: Object.assign({}, fakeService, svcOverride || {}),
      tasks: { isBusy: () => false, current: () => null, list: () => [] },
    });
    mgr._setSandboxSupportedForTest(true);
    mgr._ctx.install = async () => ({ ok: false, error: 'stub' }); // 离线：绝不触发真实 npm 安装
    return mgr;
  };
  /** 拉起路径的正向 fixture：落一个假 DSH 入口（install/ 下真实存在），
   *  让 start() 的存在性检查与 EXECUTION-CONTRACT 执行边界复校都通过。
   *  返回入口路径（7E/7H 需要它核对身份锚），调用方一行即可备好场景。 */
  const seedEntry = (mgr, inst) => {
    mgr.save(); // store.save 自建目录；instances 已置入后方可 ensureDirs
    mgr._store.ensureDirs(inst);
    // 入口路径经 sandbox.dshEntry 推导（node_modules 落点分平台），不硬编码 POSIX 形。
    const bin = sandbox.dshEntry(mgr.instancesRoot, inst);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '// fake entry for boundary recheck\n');
    return bin;
  };

  // 6a. BACKOFF + 守护关 + 退避已到期 -> 落 STOPPED，零拉起
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-off-')));
    const inst = mk('BACKOFF', { backoffUntil: Date.now() - 1 });
    mgr.instances = [inst];
    mgr.supervise('b15');
    await new Promise((r) => setImmediate(r));
    check('BACKOFF+守护关 → STOPPED（不再无限重试）且未触碰 service',
      inst.state.phase === 'STOPPED' && svcCalls.length === 0, inst.state.phase + ' ' + svcCalls.join(','));
  }
  // 6b. FAILED + 守护关 + installOk=true -> 不自动拉起（停就停红线）
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-f-')));
    const inst = mk('FAILED', { installOk: true, lastError: '安装任务登记失败' });
    mgr.instances = [inst];
    mgr.supervise('b15');
    check('FAILED+守护关 → 维持 FAILED 且零拉起', inst.state.phase === 'FAILED' && svcCalls.length === 0, inst.state.phase + ' ' + svcCalls.join(','));
  }
  // 6c. 反向（判据有牙）：守护开 + 到期 -> 走自愈拉起（BACKOFF 与 FAILED 两条入口同判）
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-on-')));
    const inst = mk('BACKOFF', { backoffUntil: Date.now() - 1 });
    inst.guardian = true;
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    mgr.supervise('b15');
    await new Promise((r) => setTimeout(r, 50));
    const backoffPulled = svcCalls.includes('startTransient') && inst.state.phase === 'STARTING';

    svcCalls.length = 0;
    const mgr2 = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-fo-')));
    const inst2 = mk('FAILED', { installOk: true, lastError: '启动失败:x' });
    inst2.guardian = true;
    mgr2.instances = [inst2];
    seedEntry(mgr2, inst2);
    mgr2.supervise('b15');
    check('反向：守护开+到期（BACKOFF）/ FAILED+installOk → 均自愈拉起',
      backoffPulled && svcCalls.includes('startTransient') && inst2.state.phase === 'STARTING',
      inst.state.phase + ' / ' + inst2.state.phase + ' ' + svcCalls.join(','));
  }

  // ---- 6e/6f. 运行意图没有第二落点：start/stop 只动相位（动作即意图）----
  //   保留「start/stop 真的动相位」与「停止未确认不谎报已停」。
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-intent-')));
    const inst = mk('STOPPED');
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    const r0 = await mgr.startInstance('b15', { fromUpgrade: true });
    const phaseAfterStart = inst.state.phase;
    const r1 = mgr.stopInstance('b15');
    check('IN-1/2 start 走到拉起 → STARTING；stop → STOPPED（用户启停就是动作本身）',
      r0.ok === true && phaseAfterStart === 'STARTING' && r1.ok === true && inst.state.phase === 'STOPPED',
      'ok=' + r0.ok + '/' + r1.ok + ' ' + phaseAfterStart + '->' + inst.state.phase);
  }
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b15-intent-unconfirmed-')), { stopUnit() { return false; } });
    const inst = mk('RUNNING');
    mgr.instances = [inst];
    const r = mgr.stopInstance('b15');
    check('IN-5 反向：停止未确认 → ok:false 且相位不动（不谎报已停）',
      r.ok === false && inst.state.phase === 'RUNNING', 'ok=' + r.ok + ' phase=' + inst.state.phase);
  }

  // ---- 6g. 手动拉起开新失败链 —— fail() 承诺的「由用户手动重试」成为真实通道 ----
  //   旧缺陷：attempts>20 后 restart() 瞬回 FAILED，清零只靠稳定 RUNNING>5min，
  //   超限实例的手动重试通道实质封死（第 4 段的 21 次循环即达该状态）。
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b26d-')));
    const inst = mk('FAILED', { restartCount: 21, backoffLevel: 5, lastError: '重试超限(崩溃)', lastFailAt: Date.now() - 1000, backoffUntil: Date.now() - 1 });
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    const r = await mgr.startInstance('b15', { manual: true });
    check('D-1 手动启动成功 → 旧链计数作废（restartCount/backoffLevel/backoffUntil 清零）',
      r.ok === true && inst.state.phase === 'STARTING' && inst.state.restartCount === 0 && inst.state.backoffLevel === 0 && inst.state.backoffUntil === null,
      'ok=' + r.ok + ' ' + JSON.stringify(inst.state));
    // 手动拉起后进程再失败，监督拍的 restart 从第 1 次重试重新走起。
    sm.restart(deps, inst, '实例进程退出');
    check('D-2 手动启动后的失败重新进 BACKOFF 计第 1 次',
      inst.state.phase === 'BACKOFF' && inst.state.restartCount === 1, inst.state.phase + ' count=' + inst.state.restartCount);
  }
  {
    const mgr = mkMgr(fs.mkdtempSync(path.join(os.tmpdir(), 'b26d-auto-')));
    const inst = mk('FAILED', { restartCount: 21, backoffLevel: 5, installOk: true });
    inst.guardian = true;
    mgr.instances = [inst];
    seedEntry(mgr, inst);
    mgr.supervise('b15');
    await new Promise((r) => setImmediate(r));
    check('D-3 自动来源拉起（监督拍 installOk 兜底）不开新链：restartCount=21 原样保留',
      inst.state.restartCount === 21, 'phase=' + inst.state.phase + ' count=' + inst.state.restartCount);
    sm.restart(deps, inst, '实例进程退出');
    check('D-3b 自动链超限判定不变：超限后再失败仍 FAILED（超限->手动重启才有出路）',
      inst.state.phase === 'FAILED' && /重试超限/.test(inst.state.lastError || ''), inst.state.phase);
  }

  // ---- 7. 控制面治理（逐实例采样拍 + 拍末 governSweep decide）+ 准入：观测(假 resstats)->
  //   每拍决策(真 governor+假机器事实)->下发(展示值)->处置(违规停单元+退避)。注入走 ctor opts。 ----
  {
    const net = require('node:net');
    const { safePort } = require(path.join(__dirname, '_ports'));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const GiB = (g) => g * 1024 * 1024 * 1024;
    const mkGovMgr = (extra) => {
      const journal = [];
      const transient = [];
      const mgr = new InstanceManager(Object.assign({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gov-')),
        logger: { info() {}, warn() {}, error() {} },
        events: { append(name, data) { journal.push({ kind: 'event', name, data }); } },
        tasks: { isBusy: () => false, current: () => null, list: () => [] },
        service: {
          daemonReload() { journal.push({ kind: 'daemonReload' }); return true; },
          // stopUnit 的 ctx（端口/run.pid/cmdline 锚 + timeoutMs 边界）纳入记录，供调用点判据核对
          stopUnit(unit, o) { journal.push({ kind: 'stopUnit', unit, ctx: o }); return true; },
          resetFailed() { return true; },
          isUnitActive() { return false; },
          transientUnitFile() { return null; },
          cleanTransient() {},
          startTransient(o) { journal.push({ kind: 'startTransient', unit: o.unit }); transient.push(o); return true; },
          setLimits(unit, alloc) { journal.push({ kind: 'setLimits', unit, alloc }); return true; },
        },
      }, extra || {}));
      mgr._setSandboxSupportedForTest(true);
      mgr._ctx.install = async () => ({ ok: false, error: 'stub：绝不真实安装' });
      return { mgr, journal, transient };
    };
    const listen = (port) => new Promise((resolve, reject) => {
      const srv = net.createServer((s) => s.destroy());
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
    const govInst = (id, port, state) => ({
      id, name: id.toUpperCase(), domain: 'sandbox', port, guardian: true,
      state: state || { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: Date.now() - 5000, allocation: null },
    });

    // 7A. 违规处置链：连续 3 个证据拍超限 -> 事件 + stopUnit + BACKOFF（复用退避链）
    {
      const port = safePort('instance-state', 0);
      const srv = await listen(port);
      const rss = Math.round(30000 * 1024 * 1024); // 30000MB：burst 顶满（16384M）仍超限
      const { mgr, journal } = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve({ rssBytes: rss, cpuMs: 5000 }) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const inst = govInst('g1', port);
      mgr.instances = [inst];
      for (let k = 0; k < 3; k++) { mgr.supervise('g1'); mgr.governSweep(); await sleep(10); }
      check('7A 迟滞爬升中不处置（内存计数未触顶即不停单元）',
        inst.state.phase === 'RUNNING' && !journal.some((j) => j.kind === 'stopUnit'), inst.state.phase);
      mgr.supervise('g1'); mgr.governSweep(); await sleep(10);
      const ev = journal.find((j) => j.kind === 'event' && j.name === 'inst_resource_violation');
      const stop = journal.findIndex((j) => j.kind === 'stopUnit');
      check('7A 连续第 3 个证据拍触发违规处置', !!ev && stop >= 0, JSON.stringify(ev && ev.data));
      check('7A 事件先于动作（既定纪律）', !!ev && stop > journal.indexOf(ev), 'stopIdx=' + stop);
      // 违规处置经 Provider 动词 + 身份锚（portable 档据此归属，绝不盲杀；有界防冻结）
      const stopEntry = stop >= 0 ? journal[stop] : null;
      // 有界超时是判据（绝不盲杀后无限等）；具体毫秒数属实现选择，只断区间。
      check('7A 违规 stopUnit 带身份锚与有界超时（W3 调用点）',
        !!stopEntry && stopEntry.ctx && stopEntry.ctx.port === port
        && stopEntry.ctx.timeoutMs > 0 && stopEntry.ctx.timeoutMs <= 60000
        && Array.isArray(stopEntry.ctx.anchors) && stopEntry.ctx.anchors.includes('--port ' + port),
        stopEntry && JSON.stringify(stopEntry.ctx && { t: stopEntry.ctx.timeoutMs, a: stopEntry.ctx.anchors }));
      check('7A 处置后走既有退避链：BACKOFF + restartCount=1',
        inst.state.phase === 'BACKOFF' && inst.state.restartCount === 1, inst.state.phase + ' n=' + inst.state.restartCount);
      check('7A 违规原因可见（lastFailure 带资源违规）', /资源违规:内存/.test(inst.state.lastFailure || ''), inst.state.lastFailure);
      check('7A 观测行回填（usage.memMb 与 allocation 均已写入，非陈旧空值）',
        !!(inst.state.usage && inst.state.usage.memMb > 0) && !!(inst.state.allocation && inst.state.allocation.memoryMax),
        JSON.stringify(inst.state.usage) + ' ' + JSON.stringify(inst.state.allocation));
      mgr.stopInstance('g1');
      check('7A 显式停止清观测（usage=null 不残留陈旧展示值）', inst.state.usage === null && inst.state.phase === 'STOPPED', String(inst.state.usage));
      srv.close();
    }
    // 7B. 突发下发展示值：双实例有需求 -> 各补真实差额（先到先得按启动序）
    {
      const pA = safePort('instance-state', 1);
      const pB = safePort('instance-state', 2);
      const srvA = await listen(pA);
      const srvB = await listen(pB);
      const rss = 7000 * 1024 * 1024; // 预留 5734.4M 之上且差额越过 10% 死区（22%），池充裕
      const { mgr } = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve({ rssBytes: rss, cpuMs: 8000 }) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const a = govInst('gb1', pA, { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: 1000, allocation: null });
      const b = govInst('gb2', pB, { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: 2000, allocation: null });
      mgr.instances = [a, b];
      mgr.supervise('gb1'); mgr.supervise('gb2'); mgr.governSweep(); await sleep(30);
      mgr.supervise('gb1'); mgr.supervise('gb2'); mgr.governSweep(); await sleep(30);
      check('7B 有需求实例补到真实用量（两实例同值、非占位空值）',
        !!a.state.allocation.memoryMax && a.state.allocation.memoryMax === b.state.allocation.memoryMax,
        a.state.allocation.memoryMax + ' / ' + b.state.allocation.memoryMax);
      // cpuPct 需相邻两拍时间差 >0（Windows 粗时钟兜底，多跑一拍）。
      mgr.supervise('gb1'); mgr.supervise('gb2'); mgr.governSweep(); await sleep(30);
      mgr.supervise('gb1'); mgr.supervise('gb2'); mgr.governSweep(); await sleep(30);
      check('7B 观测行 usage 回填（rss 即时 + cpu delta 终有值）',
        !!a.state.usage && a.state.usage.memMb > 0 && Number.isFinite(a.state.usage.cpuPct),
        JSON.stringify(a.state.usage));
      srvA.close(); srvB.close();
    }
    // 7C. 准入：预算摊薄跌破下限显式拒绝；fromUpgrade 旁路 + 启动属性带 MemoryHigh
    {
      const { mgr, transient } = mkGovMgr({
        machineFacts: () => ({ totalMemBytes: GiB(1), cpuCount: 8 }), // 预算 716.8MB：两实例必跌破 512M 下限
      });
      const running = govInst('gc1', 0, { phase: 'RUNNING', restartCount: 0, allocation: { memoryMax: '512M', cpuQuota: '280%' } });
      const fresh = { id: 'gc2', name: 'GC2', domain: 'sandbox', port: 0, guardian: false, state: { phase: 'STOPPED', restartCount: 0 } };
      mgr.instances = [running, fresh];
      seedEntry(mgr, fresh);
      const r1 = await mgr.startInstance('gc2');
      // 只断「显式拒绝、绝不静默超卖」这一行为（文案契约由 governor-test G5 覆盖）。
      check('7C 预算已满 -> 显式拒绝（绝不静默超卖）', r1.ok === false && /预算已满/.test(r1.error || ''), JSON.stringify(r1));
      check('7C 被拒实例未被拉起且相位不动', !transient.some((t) => t.unit === 'dsh-web@gc2') && fresh.state.phase === 'STOPPED', fresh.state.phase);
      const r2 = await mgr.startInstance('gc2', { fromUpgrade: true });
      check('7C fromUpgrade 旁路准入（升级重启验证必须真正拉起）', r2.ok === true && fresh.state.phase === 'STARTING', JSON.stringify(r2) + ' ' + fresh.state.phase);
      const t = transient.find((x) => x.unit === 'dsh-web@gc2');
      check('7C 启动属性下发 MemoryMax/MemoryHigh（0.9x 节流先于 OOM）',
        !!t && t.props.includes('MemoryMax=512M') && t.props.includes('MemoryHigh=461M'), t && JSON.stringify(t.props));
    }
    // 7D. 采样无证据不判违规：sampleAsync 恒 null -> 永不处置
    {
      const port = safePort('instance-state', 3);
      const srv = await listen(port);
      const { mgr, journal } = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve(null) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const inst = govInst('gd1', port);
      mgr.instances = [inst];
      for (let k = 0; k < 6; k++) { mgr.supervise('gd1'); mgr.governSweep(); await sleep(5); }
      check('7D 采样恒失败 -> 无证据不处置（六拍仍 RUNNING、零违规事件）',
        inst.state.phase === 'RUNNING' && !journal.some((j) => j.name === 'inst_resource_violation'), inst.state.phase);
      srv.close();
    }
    // 7E. 执行面调用点：单元档门控（非 systemd 平台零结构残留）+ 启停身份锚贯通 + setLimits 动态下发
    {
      const sdir = path.join(os.tmpdir(), 'dsh-w3-never-' + process.pid + '-' + Date.now());
      const port = safePort('instance-state', 4);
      const { mgr, journal, transient } = mkGovMgr({ systemdDir: sdir });
      const inst = govInst('ge1', port, { phase: 'STOPPED', restartCount: 0, allocation: null });
      mgr.instances = [inst];
      const bin = seedEntry(mgr, inst);
      const r = await mgr.startInstance('ge1', { fromUpgrade: true });
      check('7E 无 supportsUnits 的 provider：_prepareSystemd 门控直过（不 mkdir、不 daemonReload）',
        r.ok === true && !journal.some((j) => j.kind === 'daemonReload') && !fs.existsSync(sdir), sdir);
      const t0 = transient.find((x) => x.unit === 'dsh-web@ge1');
      check('7E startTransient 带身份锚（port + 入口锚同源 launchCtx 推导）',
        !!t0 && t0.port === port
        && t0.anchors.includes('--port ' + port) && t0.anchors.includes(bin),
        t0 && JSON.stringify(t0.anchors));
      mgr.stopInstance('ge1');
      const su = journal.filter((j) => j.kind === 'stopUnit').pop();
      // 判据是「启停用同一身份锚 + 有界超时」（防归属漂移/无限等），不锁具体秒数。
      check('7E stopUnit 带**同一**身份锚与有界超时（启停同值防归属漂移）',
        !!su && su.ctx && su.ctx.port === port && su.ctx.pidFile === t0.pidFile
        && JSON.stringify(su.ctx.anchors) === JSON.stringify(t0.anchors)
        && su.ctx.timeoutMs > 0 && su.ctx.timeoutMs <= 60000,
        su && JSON.stringify({ t: su.ctx.timeoutMs, a: su.ctx.anchors }));

      // setLimits：alloc 变化的 RUNNING 拍必须下发（值只来自 governor alloc）；不变拍不重发。
      const port2 = safePort('instance-state', 5);
      const srv2 = await listen(port2);
      const g2 = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve({ rssBytes: 6000 * 1024 * 1024, cpuMs: 1000 }) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const inst2 = govInst('ge2', port2);
      g2.mgr.instances = [inst2];
      g2.mgr.supervise('ge2'); g2.mgr.governSweep(); await sleep(10);
      const sl = g2.journal.find((j) => j.kind === 'setLimits');
      check('7E RUNNING 拍 alloc 变化即下发 setLimits（运行期动态化，不等重启）',
        !!sl && sl.unit === 'dsh-web@ge2' && !!sl.alloc && sl.alloc.memoryMax === inst2.state.allocation.memoryMax,
        sl && JSON.stringify(sl.alloc));
      const n1 = g2.journal.filter((j) => j.kind === 'setLimits').length;
      g2.mgr.supervise('ge2'); g2.mgr.governSweep(); await sleep(10);
      check('7E 未变化拍不重发 setLimits（迟滞收敛防写放大）',
        g2.journal.filter((j) => j.kind === 'setLimits').length === n1, 'n=' + n1);
      srv2.close();
    }
    // 7F. 两实例同超限 -> decide 每拍恰一次（逐实例监督拍会让违规 tick 双计）；第 4 拍一次扫描同时处置两违规。
    {
      const p1 = safePort('instance-state', 6);
      const p2 = safePort('instance-state', 7);
      const srv1 = await listen(p1);
      const srv2b = await listen(p2);
      const rss = Math.round(30000 * 1024 * 1024);
      const { mgr, journal } = mkGovMgr({
        resstats: { sampleAsync: () => Promise.resolve({ rssBytes: rss, cpuMs: 5000 }) },
        machineFacts: () => ({ totalMemBytes: GiB(16), cpuCount: 8 }),
      });
      const x = govInst('gf1', p1, { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: 1000, allocation: null });
      const y = govInst('gf2', p2, { phase: 'RUNNING', restartCount: 0, backoffLevel: 0, startAt: 2000, allocation: null });
      mgr.instances = [x, y];
      for (let k = 0; k < 3; k++) { mgr.supervise('gf1'); mgr.supervise('gf2'); mgr.governSweep(); await sleep(10); }
      check('7F 双实例三拍仍不处置（每拍一次 decide）',
        x.state.phase === 'RUNNING' && y.state.phase === 'RUNNING' && !journal.some((j) => j.kind === 'stopUnit'),
        x.state.phase + '/' + y.state.phase);
      mgr.supervise('gf1'); mgr.supervise('gf2'); mgr.governSweep(); await sleep(10);
      const evs = journal.filter((j) => j.kind === 'event' && j.name === 'inst_resource_violation');
      const stops = journal.filter((j) => j.kind === 'stopUnit');
      check('7F 第 4 拍单扫描同时处置两违规（事件+停单元各 2、双 BACKOFF）',
        evs.length === 2 && stops.length === 2 && x.state.phase === 'BACKOFF' && y.state.phase === 'BACKOFF'
        && x.state.restartCount === 1 && y.state.restartCount === 1,
        'ev=' + evs.length + ' stop=' + stops.length + ' ' + x.state.phase + '/' + y.state.phase);
      srv1.close(); srv2b.close();
    }

    // 7H. 启动命令的「不自弹浏览器」由内核补齐：存量 command 是旧版默认 [node, bin, 'web', '--port', P]，
    //   没带 --no-open -> dsh 自己拉起浏览器（绕过外部打开唯一出口）。只补**缺省**，已显式写开关的原样交回。
    {
      // 命令里的入口必须落在该实例自己的沙箱安装根内，否则执行边界复校先拒（7E 同形）。
      const startWith = async (id, slot, mk) => {
        const port = safePort('instance-state', slot);
        const { mgr, transient } = mkGovMgr({});
        const inst = govInst(id, port, { phase: 'STOPPED', restartCount: 0, allocation: null });
        mgr.instances = [inst];
        const bin = seedEntry(mgr, inst);
        inst.command = mk(bin, port);
        const r = await mgr.startInstance(id, { fromUpgrade: true });
        const t = transient.find((x) => x.unit === 'dsh-web@' + id);
        return { r, cmd: (t && t.cmd) || null, given: mk(bin, port) };
      };
      const LEGACY = (bin, port) => [process.execPath, bin, 'web', '--port', String(port)];
      const g1 = await startWith('hh1', 8, LEGACY);
      check('7H 存量旧命令（无开关）拉起时补齐 --no-open，其余参数原样',
        g1.r.ok === true && JSON.stringify(g1.cmd) === JSON.stringify(g1.given.concat(['--no-open'])),
        JSON.stringify(g1.cmd));
      const g2 = await startWith('hh2', 9, (bin, port) => LEGACY(bin, port).concat(['--no-open']));
      check('7H 已带 --no-open 的命令不重复补（补齐必须幂等）',
        !!g2.cmd && g2.cmd.filter((a) => a === '--no-open').length === 1 && JSON.stringify(g2.cmd) === JSON.stringify(g2.given),
        JSON.stringify(g2.cmd));
      const g3 = await startWith('hh3', 10, (bin, port) => LEGACY(bin, port).concat(['--open']));
      check('7H 反向（能力不被砍）：用户显式写了开关的命令一字不改地交回',
        !!g3.cmd && !g3.cmd.includes('--no-open') && JSON.stringify(g3.cmd) === JSON.stringify(g3.given),
        JSON.stringify(g3.cmd));
    }

    // ---- 8. 冷启动历史态收敛：normalizeInstance（legacy 布尔对 → remoteMode 三态）----
    //   唯一收敛点：三态 + 旧键剔除 + 幂等；残留旧键 = 双轨真相（下一轮读盘同时看到两个结论）。
    {
      const { normalizeInstance } = require(path.join(ROOT, 'src', 'domains', 'instance', 'model.js'));
      const base = () => ({ id: 'i', name: 'n', port: 29051 });
      const mig = (extra) => Object.assign(base(), extra);
      const cases = [
        ['remoteEnabled+frpEnabled → wan', mig({ remoteEnabled: true, frpEnabled: true }), 'wan'],
        ['仅 remoteEnabled → lan', mig({ remoteEnabled: true, frpEnabled: false }), 'lan'],
        ['frpEnabled=true 但总远程关 → off（关是安全方向，不被 frp 意图翻起）', mig({ remoteEnabled: false, frpEnabled: true }), 'off'],
        ['两者皆 false / 无 legacy 字段 → off', mig({ remoteEnabled: false, frpEnabled: false }), 'off'],
        ['已是三态直读（lan）', mig({ remoteMode: 'lan' }), 'lan'],
        ['三态在场优先于 legacy 布尔（新值不被旧对推翻）', mig({ remoteMode: 'wan', remoteEnabled: false, frpEnabled: false }), 'wan'],
        ['非法三态值回落 legacy 推导；无 legacy 则 off', mig({ remoteMode: 'bogus', remoteEnabled: true }), 'lan'],
      ];
      for (const [label, input, want] of cases) {
        const r = normalizeInstance(input);
        check('normalizeInstance ' + label + ' → ' + want, r.remoteMode === want, JSON.stringify({ got: r.remoteMode, want }));
      }
      // 旧键必须消失（残留会让下一轮读盘看到双轨真相）
      const legacyRow = () => mig({
        remoteEnabled: true, frpEnabled: true, frpRemotePort: 7001, wanPort: 22001, dshToken: 'STALE',
      });
      const r = normalizeInstance(legacyRow());
      check('normalizeInstance 迁移后 legacy 键全部剔除（零双轨）',
        !('remoteEnabled' in r) && !('frpEnabled' in r) && !('frpRemotePort' in r)
          && !('wanPort' in r) && !('dshToken' in r),
        JSON.stringify(Object.keys(r)));
      check('normalizeInstance 迁移幂等（二次 normalize 不改结果 = 落盘后无历史态可推）',
        normalizeInstance(r).remoteMode === 'wan', JSON.stringify(normalizeInstance(r)));
    }
  }
})().catch((e) => { check('supervise 块无异常', false, e && e.message); }).then(() => {
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
});
