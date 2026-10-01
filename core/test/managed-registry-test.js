#!/usr/bin/env node
'use strict';

// 管家注册机（ManagedRegistry）单测 —— 控制平面 v3 R0 地基。
// 覆盖：注册/注销(级联释放端口)/更新/查询/持久化恢复/应然-实然分离/非法输入/类型表。

const path = require('node:path');
const os = require('node:os');
const fs2 = require('node:fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs2.mkdtempSync(path.join(os.tmpdir(), 'mreg-'));
const { ManagedRegistry, PHASES, MANAGED_KINDS } = require(path.join(ROOT, 'src', 'app', 'control', 'registry'));

let failures = 0;
let checks = 0;
const check = (name, cond, extra) => { checks++; if (!cond) failures++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); };

// 假端口注册表（owner 语义 + release 记录）
const released = [];
const fakePorts = {
  _reg: new Map(),
  isRegistered: function (p) { return this._reg.has(p); },
  allocateMark: function (p, role, owner) { this._reg.set(p, { role, owner }); },
  release: function (p) { released.push(p); this._reg.delete(p); },
};

(async () => {
  const file = path.join(TMP, 'managed-objects.json');
  const events = [];
  const reg = new ManagedRegistry({ file, logger: null, events: { append: (t, d) => events.push(t) }, ports: fakePorts });

  // 1. 注册
  const dsh = reg.register({ kind: 'dsh', id: 'main', name: '主实例', desired: 'running', guardian: true, ownership: { ports: [{ role: 'dsh-main', port: 3080 }], rootPath: '/home/u/.dsh', processMode: 'spawn' } });
  check('注册 dsh 返回目录项', !!dsh && dsh.id === 'main' && dsh.phase === 'stopped');
  // 沙箱实例注册（「注册成功」由下方查询契约 byKind('sandbox-instance') 断言，不另打恒真采样）
  reg.register({ kind: 'sandbox-instance', id: 'inst-1', name: '沙箱1', desired: 'running', guardian: false, ownership: { ports: [{ role: 'inst', port: 3200 }], rootPath: '/data/instances/inst-1', unit: 'dsh-web@inst-1' } });
  // 查询面：list 顺序 / byKind / get 都属「目录项能按 id、kind、插入序取到」这一个契约。
  check('查询契约：list 顺序 + byKind + get',
    reg.list().map(o => o.id).join(',') === 'main,inst-1' && reg.byKind('sandbox-instance').length === 1 && reg.get('main').kind === 'dsh');
  check('kind 能力', MANAGED_KINDS.dsh.guardable === true && MANAGED_KINDS.plugin.startable === false);
  // PHASES 只断「核心相位在册 + 无重复」：逐字抄全量词表的写法让合法新增相位即红。
  check('PHASES 含核心相位且无重复',
    ['stopped', 'starting', 'running', 'failed'].every((x) => PHASES.indexOf(x) >= 0) && new Set(PHASES).size === PHASES.length, JSON.stringify(PHASES));

  // 2. 非法输入
  let threw = 0;
  try { reg.register({ kind: 'nope', id: 'x' }); } catch { threw++; }
  try { reg.register({ kind: 'dsh', id: 'main' }); } catch { threw++; } // 重复
  try { reg.register({ kind: 'dsh' }); } catch { threw++; } // 无 id
  check('非法 kind/重复/缺 id 均拒绝', threw === 3);

  // 3. update（应然申报）
  reg.update('main', { desired: 'stopped' });
  check('update 申报 desired 生效', reg.get('main').desired === 'stopped');
  const bad = reg.update('main', { desired: 'maybe' });
  check('非法 desired 拒绝', !bad.ok);
  check('update 未注册', !reg.update('nope', {}).ok);

  // 4. 应然/实然分离：观测写入不落盘；phase 只能经 setPhase
  reg.applyObservation('main', { ok: true });
  check('观测写入内存', reg.get('main').lastObserved && reg.get('main').lastObserved.ok === true);
  reg.setPhase('main', 'running');
  check('setPhase 生效', reg.get('main').phase === 'running');
  reg.setPhase('main', 'huh');
  check('非法 phase 忽略', reg.get('main').phase === 'running');

  // 5. 持久化恢复（文件只含应然+所有权+受管 phase，不含观测）；
  //    「观测不落盘」以**重载后 lastObserved === null** 为判据（不对文件字节做 indexOf 扫描）。
  const reg2 = new ManagedRegistry({ file, logger: null, events: null, ports: fakePorts });
  check('恢复 2 对象，且应然/phase/所有权字段面齐全、观测不落盘',
    reg2.count() === 2 && reg2.get('main').desired === 'stopped' && reg2.get('main').phase === 'running'
    && reg2.get('main').ownership.ports[0].port === 3080 && reg2.get('main').lastObserved === null,
    JSON.stringify({ c: reg2.count(), desired: reg2.get('main').desired, phase: reg2.get('main').phase }));
  check('文件带 schema 标记（跨版本读同一文件的格式契约）',
    fs2.readFileSync(file, 'utf8').indexOf('managed-objects@1') >= 0);

  // 6. 注销级联（释放所有权端口）
  const before = released.length;
  reg2.unregister('main');
  check('注销：对象消失 + 所有权端口被释放（不泄漏）',
    !reg2.get('main') && reg2.count() === 1 && released.length > before && released.indexOf(3080) >= 0, String(released.length));
  // 事件在独立文件实例上验证（避免多实例共享主 file 相互覆盖）
  const evtFile = path.join(TMP, 'evt-objects.json');
  const regEvt = new ManagedRegistry({ file: evtFile, logger: null, events: { append: (t) => events.push(t) } });
  regEvt.register({ kind: 'dsh', id: 'tmp-evt' });
  regEvt.unregister('tmp-evt');
  check('注销事件', events.filter(e => e === 'managed_object_removed').length >= 1);
  const reg3 = new ManagedRegistry({ file, logger: null });
  check('注销后持久化生效(重启不再现)', reg3.count() === 1 && !reg3.get('main'));

  // 7. adapter 挂接
  reg.registerAdapter('dsh', { observe: () => ({ ok: true }) });
  check('adapter 可挂接/读取', !!reg.adapter('dsh'));
  let athrew = 0;
  try { reg.registerAdapter('nope', {}); } catch { athrew++; }
  check('未知类型 adapter 拒绝', athrew === 1);

  // 8. heartbeat：观测收集/节流/异常隔离/未挂 adapter 跳过
  const hbFile = path.join(TMP, 'hb-objects.json');
  const hb = new ManagedRegistry({ file: hbFile, logger: null, events: null });
  let observeCount = 0;
  hb.register({ kind: 'sandbox-instance', id: 's1' });
  hb.register({ kind: 'sandbox-instance', id: 's2', ownership: { meta: { tickEvery: 6 } } }); // 节流对象
  hb.registerAdapter('sandbox-instance', { observe: (e) => { observeCount++; if (e.id === 's1') return { ok: true }; throw new Error('boom'); } });
  hb.register({ kind: 'dsh', id: 'm' }); // 无 adapter
  const r1 = await hb.heartbeat(1000);
  check('heartbeat 观测到 ok 对象并写入实然',
    r1.observed.indexOf('s1') >= 0 && !!hb.get('s1').lastObserved && hb.get('s1').lastObserved.ok === true);
  check('heartbeat 跳过无 adapter 对象', r1.observed.indexOf('m') < 0);
  // 异常隔离：抛错对象既不进 observed，又必须在 errors 里可观测。
  check('heartbeat 异常隔离并上报(s2)',
    r1.observed.indexOf('s2') < 0 && r1.errors.length === 1 && r1.errors[0].indexOf('s2') >= 0);
  const r2 = await hb.heartbeat(1000);
  // 节流（tickEvery=6 的 s2 跳过）与「每拍对象继续观测（s1）」是同一拍的两面。
  check('heartbeat 节流生效(s2 跳过)且每拍对象继续观测(s1)',
    r2.observed.indexOf('s2') < 0 && r2.observed.indexOf('s1') >= 0);

  // 8b. 拍末钩子 onBeatDone：每拍恰一次（不随条目数放大）、带拍汇总、钩子异常不断心跳
  {
    const hkFile = path.join(TMP, 'hb-hook.json');
    const hk = new ManagedRegistry({ file: hkFile, logger: null, events: null });
    const seen = [];
    hk.register({ kind: 'sandbox-instance', id: 'h1' });
    hk.register({ kind: 'sandbox-instance', id: 'h2' });
    hk.register({ kind: 'sandbox-instance', id: 'h3' });
    hk.registerAdapter('sandbox-instance', { observe: () => ({ ok: true }) });
    hk.onBeatDone = (sum) => { seen.push(sum); };
    const r3 = await hk.heartbeat(1000);
    check('onBeatDone 每拍恰一次（3 条目不放大）、且收到与返回同源的拍汇总',
      seen.length === 1 && !!seen[0] && seen[0].observed === r3.observed && seen[0].errors === r3.errors, 'n=' + seen.length);
    await hk.heartbeat(1000); // 第二拍
    hk.onBeatDone = () => { throw new Error('hook boom'); };
    const r4 = await hk.heartbeat(1000);
    check('onBeatDone 异常隔离（心跳仍返回全量 observed）',
      r4.observed.length === 3 && r4.errors.length === 0, JSON.stringify(r4));
  }

  // 9. heartbeat derivePhase（daemon 类）：desired x 观测收敛 phase
  const dpFile = path.join(TMP, 'dp-objects.json');
  const dp = new ManagedRegistry({ file: dpFile, logger: null });
  dp.register({ kind: 'router-daemon', id: 'rd', desired: 'running', guardian: true });
  dp.registerAdapter('router-daemon', { supervise: () => ({ ok: true }), derivePhase: true });
  await dp.heartbeat(1000);
  check('derivePhase: desired running + ok → phase running', dp.get('rd').phase === 'running');
  dp.registerAdapter('router-daemon', { supervise: () => ({ ok: false }), derivePhase: true });
  await dp.heartbeat(1000);
  check('derivePhase: 失联 → phase stopped', dp.get('rd').phase === 'stopped');
  // 10. heartbeat 逐对象超时：单个 adapter 卡死不得停摆整条心跳 —— `await fn(e)` 无超时即让心跳永停，
  //   而心跳是 main 收敛/沙箱监督/daemon 监督的**唯一周期驱动**。
  {
    const toFile = path.join(TMP, 'hb-timeout.json');
    const to = new ManagedRegistry({ file: toFile, logger: null });
    to.register({ kind: 'sandbox-instance', id: 'hung' });
    to.register({ kind: 'sandbox-instance', id: 'healthy' });
    to.registerAdapter('sandbox-instance', {
      supervise: (e) => (e.id === 'hung' ? new Promise(() => {}) : { ok: true }),
    });
    // 保活：超时定时器 unref 了，无其它句柄时进程会提前退出 -> 断言跑不到
    const keepAlive = setInterval(() => {}, 100);
    const t0 = Date.now();
    const r = await to.heartbeat(50); // 上限 = 50 x 6 = 300ms
    clearInterval(keepAlive);
    const elapsed = Date.now() - t0;
    check('heartbeat 卡死对象有超时（不会永不返回）', elapsed < 5000, elapsed + 'ms');
    check('heartbeat 超时对象被记入 errors（可观测）',
      r.errors.some((x) => x.indexOf('hung') >= 0), JSON.stringify(r.errors));
    check('heartbeat 卡死对象仍被记为不在线（ok:false）',
      to.get('hung').lastObserved && to.get('hung').lastObserved.ok === false, 'ok:false');
    check('heartbeat 后续健康对象**仍被观测**（不因前一个卡死而跳过）',
      r.observed.indexOf('healthy') >= 0 && to.get('healthy').lastObserved.ok === true,
      JSON.stringify(r.observed));
  }

  // 11. 既有目录文件损坏 != 首启空目录 ——
  //     改名 .bad-<ts> 保全原始字节 + 以「未加载」态启动（允许 state.json 种子回灌）+ 事件不静默。
  {
    const cf = path.join(TMP, 'corrupt-objects.json');
    fs2.writeFileSync(cf, '{"objects":[{"kind":"dsh"'); // 半截 JSON
    const cEvts = [];
    const regC = new ManagedRegistry({ file: cf, logger: null, events: { append: (t) => cEvts.push(t) } });
    check('A1c 损坏目录降级为空目录（不崩）', regC.count() === 0, String(regC.count()));
    const bads = fs2.readdirSync(TMP).filter((f) => f.indexOf('corrupt-objects.json.bad-') === 0);
    check('A1c 原始字节被改名保全到 .bad-<ts>',
      bads.length === 1 && fs2.readFileSync(path.join(TMP, bads[0]), 'utf8') === '{"objects":[{"kind":"dsh"',
      JSON.stringify(bads));
    check('A1c managed_registry_corrupt 事件（不静默）', cEvts.indexOf('managed_registry_corrupt') >= 0, JSON.stringify(cEvts));
    regC.register({ kind: 'dsh', id: 'fresh', desired: 'running' });
    check('A1c 保全后新目录可正常落盘（原路径已是新内容）',
      JSON.parse(fs2.readFileSync(cf, 'utf8')).objects.some((o) => o.id === 'fresh'), 'ok');
    // 单条坏 entry 不得中断整份加载（其后合法条目不丢）
    const pf = path.join(TMP, 'partial-objects.json');
    fs2.writeFileSync(pf, JSON.stringify({ schema: 'managed-objects@1', objects: [
      { kind: 'bogus-kind', id: 'b' },
      { kind: 'dsh', id: 'ok-1', desired: 'running' },
    ] }));
    const regP = new ManagedRegistry({ file: pf, logger: null });
    check('A1c 未知 kind 单条跳过，其后合法条目仍恢复',
      regP.count() === 1 && !!regP.get('ok-1'), String(regP.count()));
  }

  // 12. 生命周期镜像：与 derivePhase（观测 ok → running / 失联 → stopped）同判据；
  //   重启计数链路落在 daemon-lifecycle-test.js。
  {
    const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
    const { registerAll } = require(path.join(ROOT, 'src', 'app', 'control', 'adapters'));
    const lcTmp = fs2.mkdtempSync(path.join(os.tmpdir(), 'mreg-lc-'));
    const sup = new Supervisor({
      command: ['node', '-e', '0'],
      healthUrl: 'http://127.0.0.1:1/',
      probeIntervalMs: 100000, // 不触发 tick 副作用（本段只做视图同步，不 start 定时器）
      apiHost: '127.0.0.1', apiPort: 31990,
      stateFile: path.join(lcTmp, 'state.json'),
      logFile: path.join(lcTmp, 'events.log'),
      supervisorLogFile: path.join(lcTmp, 'sup.log'),
      dshLogFile: path.join(lcTmp, 'dsh.log'),
      upgradeLogFile: path.join(lcTmp, 'up.log'),
      distDir: path.join(lcTmp, 'dist'),
      switcherDir: path.join(lcTmp, 'sw'),
      providerFile: path.join(lcTmp, 'sw', 'providers.json'),
      lanDaemon: false, useSystemdForMain: false,
    });
    registerAll(sup.lifecycleManager, {
      router: sup.router, lan: sup.lan, instances: sup.instances,
      supervisor: sup, pluginManager: sup.pluginManager, logger: sup.logger,
    });
    const ids = sup.lifecycleManager.all().map((l) => l.id).sort().join(',');
    check('M0 lifecycle 模块注册齐（dsh/instances/lan/router 等）',
      /router/.test(ids) && /dsh/.test(ids) && /instances/.test(ids), ids);
    const lc = sup.lifecycleManager.get('router');
    // 前置：router 未注册时下面 M5/M7 全部无意义 —— 直接抛错定位。
    if (!lc) throw new Error('M5/M7 前置失败：router 生命周期未注册（M0 已判过注册齐）');

    // M5 视图同步不污染 router 业务状态（只写统一状态机）：router 自述状态逐字节未被改写。
    //    原写法另含 !hasOwnProperty('phase'|'healthy'|'desired') 半句 = schema 形状锁，按形状锁纪律去除。
    const rsBefore = JSON.stringify(sup.routerStatus());
    sup._syncRouterLifecycleView({ ok: false, error: 'x' }); sup._syncRouterLifecycleView({ ok: true });
    check('M5 视图同步不污染 router 业务状态（router 自述状态内容不变）',
      rsBefore === JSON.stringify(sup.routerStatus()), JSON.stringify(sup.routerStatus()));

    // M7 守护开关：域 A（dsh/instances）guardian 跟用户开关走（默认关）；域 B 基础设施
    //   （router-daemon/lan-daemon）**不设 guardian**（无用户意图轴，由保活路径无条件拉起）。
    const gRouter = sup.lifecycleManager.get('router');
    const gLan = sup.lifecycleManager.get('lan');
    const gDsh = sup.lifecycleManager.get('dsh');
    const gInst = sup.lifecycleManager.get('instances');
    check('M7 域模型：基础设施(router/lan)不设 guardian，域 A(dsh/instances) 默认为关',
      gRouter.guardian !== true && gLan.guardian !== true && gDsh.guardian !== true && gInst.guardian !== true,
      JSON.stringify({ router: gRouter.guardian, lan: gLan.guardian, dsh: gDsh.guardian, instances: gInst.guardian }));
  }

  console.log('');
  // 真实计数（见文件头说明）：passed + failed 必须**恒等于**实际执行数。
  console.log('结果: ' + (checks - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
