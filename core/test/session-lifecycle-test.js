#!/usr/bin/env node
'use strict';


const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  console.log('== 会话状态机（契约 §3）==');
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '-e', '0'],
    healthUrl: 'http://127.0.0.1:28181/',
    tickIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28180,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'up.log'),
  };
  const sup = new Supervisor(cfg);
  check('会话态初始 = starting', sup.sessionState() === 'starting', sup.sessionState());

  console.log('== stopping 抑制拉起 ==');
  let spawned = 0;
  sup._startProcess = async () => { spawned++; sup._mSetPhase('STARTING'); };
  sup._mSetDesired('running');
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  const spawnedWhenRunning = spawned;
  check('running 会话态：显式意图可触发拉起', spawnedWhenRunning >= 1, 'spawned=' + spawnedWhenRunning);

  spawned = 0;
  sup._setSessionState('stopping');
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  check('stopping 期间抑制拉起（spawned=0）', spawned === 0, 'spawned=' + spawned);

  console.log('== 退出（契约 §4.1）==');
  sup._setSessionState('running'); // 复位（上一步测试停在 stopping）
  const r1 = await sup.shutdownAll();
  check('shutdownAll → 回执 ok/sessionState=stopped、会话态 stopped、_sessionHalting() 生效',
    r1 && r1.ok === true && r1.sessionState === 'stopped' && sup.sessionState() === 'stopped' && sup._sessionHalting() === true, JSON.stringify(r1));
  check('退出后 shellHalted 跨守卫重启继承且 statusSummary 暴露（抑制看护）',
    sup.statusSummary().shellHalted === true, JSON.stringify(sup.statusSummary().shellHalted));
  const r2 = await sup.shutdownAll();
  check('shutdownAll 幂等（already 回执）', r2 && r2.ok === true && r2.already === true && r2.sessionState === 'stopped', JSON.stringify(r2));

  spawned = 0;
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  check('stopped 期间同样抑制拉起', spawned === 0, 'spawned=' + spawned);

  console.log('== 阶段 2 意图单源（恢复语义）==');
  {
    const s2 = new Supervisor(cfg);
    s2._startProcess = async () => { spawned++; s2._mSetPhase('STARTING'); };
    spawned = 0;
    s2._mSetDesired('running');
    s2._setSessionState('running');
    s2._mSetPhase('STOPPED');
    s2.intents.clear(); // 无显式意图（模拟重启后内存态为空）
    await s2.tick();
    check('P2-A desired=running+guardian=false+无意图 → 拉起（恢复语义）', spawned >= 1, 'spawned=' + spawned);

    spawned = 0;
    s2._mSetDesired('stopped');
    s2._setSessionState('running');
    s2._mSetPhase('STOPPED');
    s2.intents.clear();
    await s2.tick();
    check('P2-B desired=stopped → 不拉起', spawned === 0, 'spawned=' + spawned);

    spawned = 0;
    s2._mSetDesired('running');
    s2._setSessionState('running');
    s2._crashHalted = true; // 模拟未守护崩溃停靠
    s2._mSetPhase('STOPPED');
    s2.intents.clear();
    await s2.tick();
    check('P2-C 未守护崩溃停靠后不自动拉起（guardian 语义保留）', spawned === 0, 'spawned=' + spawned);

    spawned = 0;
    s2._mSetDesired('stopped');
    s2._crashHalted = true;
    s2._mSetPhase('STOPPED');
    s2.setDesired('running'); // 显式启动：清停靠 + 注册意图 + 触发 tick
    await new Promise((r) => setTimeout(r, 80)); // 等内部 tick 结算（_ticking 守卫下 await tick 会空跑）
    check('P2-D 显式启动清除崩溃停靠标记并拉起', s2._crashHalted === false && spawned >= 1,
      'halted=' + s2._crashHalted + ' spawned=' + spawned);
  }

  console.log('== /session API ==');
  const lifecycleApi = require(path.join(ROOT, 'src', 'api', 'domains', 'lifecycle'));
  check('lifecycle.owns 覆盖 /session/status 与 /session/stop',
    lifecycleApi.owns('/session/status') === true && lifecycleApi.owns('/session/stop') === true);

  console.log('== 阶段 3 会话态贯通 ==');
  {
    const s3 = new Supervisor(cfg);
    check('P3-G shellHalted 跨守卫重启继承（新守卫读回）', s3.statusSummary().shellHalted === true, String(s3.statusSummary().shellHalted));
    const snap = s3.statusSummary();
    check('P3-A statusSummary 暴露 sessionState', snap.sessionState === 'starting', JSON.stringify(snap.sessionState));
    s3._setSessionState('stopping');
    check('P3-B sessionState 随迁移更新', s3.statusSummary().sessionState === 'stopping', s3.statusSummary().sessionState);

    let sandboxTouched = false, daemonTouched = false;
    s3.instances = { supervise: async () => { sandboxTouched = true; }, probeInstance: () => ({ running: true }) };
    s3._syncSandboxRegistryEntry = () => {};
    const sr = await s3._sandboxSuperviseOnce({ id: 'inst-x' });
    check('P3-C stopping 期间沙箱 supervise 短路（全域）', sr && sr.ok === false && sandboxTouched === false, JSON.stringify(sr));
    const dr = await s3._daemonSuperviseOnce('router');
    check('P3-D stopping 期间 daemon supervise 短路（全域）', dr && dr.ok === false && daemonTouched === false, JSON.stringify(dr));
  }


  console.log('== P2 B1 能力执法 ==');
  {
    const { LifecycleManager } = require(path.join(ROOT, 'src', 'app', 'control', 'manager'));
    const { registerAll } = require(path.join(ROOT, 'src', 'app', 'control', 'adapters'));
    let emb = 0, writes = 0; // 本文件自备的「内嵌 router 被直调」与「写口被调」计数
    const mkMgr = (supOver) => {
      const m = new LifecycleManager({});
      registerAll(m, {
        router: { start: async () => { emb++; return { ok: true }; }, stop: async () => { emb++; return { ok: true }; }, status: () => ({}) },
        lan: { reconcile: async () => {}, syncFrpc: () => {}, shutdown: () => {}, status: () => ({}) },
        instances: { instances: [] },
        supervisor: Object.assign({ setDesired: () => ({ ok: true }), mainGuardian: () => false, desired: 'stopped', phase: 'STOPPED', statusSummary: () => ({}) }, supOver || {}),
        pluginManager: {},
      });
      return m;
    };

    const mgr = mkMgr({ requestRestart: () => ({ ok: true }), setRouterRunning: async () => ({ ok: true }) });
    check('可启停模块 startable=true（dsh/router/lan）；聚合模块（instances/plugins）startable=false',
      ['dsh', 'router', 'lan'].every((id) => mgr.get(id).startable === true)
        && ['instances', 'plugins'].every((id) => mgr.get(id).startable === false), 'ok');
    check('guardable=false → guardian 锁定 false，且 snapshot 暴露 startable/guardable',
      mgr.get('plugins').guardable === false && mgr.get('plugins').guardian === false
        && mgr.get('plugins').snapshot().startable === false && mgr.get('router').snapshot().startable === true, 'ok');
    const r1 = await mgr.start('plugins');
    const r2 = await mgr.stop('instances');
    const r3 = await mgr.restart('plugins');
    check('不可启停模块 start/stop/restart 被拒（非假成功）',
      r1.ok === false && r2.ok === false && r3.ok === false && /不可启停/.test(r1.error || ''), JSON.stringify(r1));
    check('可启停模块仍放行', (await mgr.start('router')).ok === true, 'ok');

    // router 启停唯一写口是 setRouterRunning（同时落 config.routerAutostart）；缺写口必须显式拒绝，否则读侧出现第二真相。
    emb = 0;
    const mgr2 = mkMgr({});
    const rNoWriter = await mgr2.start('router');
    check('缺 setRouterRunning 写口时 start 被拒（非假成功）', rNoWriter.ok === false && /setRouterRunning/.test(rNoWriter.error || ''), JSON.stringify(rNoWriter).slice(0, 90));
    check('被拒的 start 不留 running 意图且不绕过持久化直调内嵌 router',
      mgr2.get('router').desired !== 'running' && emb === 0, 'desired=' + mgr2.get('router').desired + ' embedded=' + emb);
    emb = 0;
    const mgr3 = mkMgr({ setRouterRunning: async (on) => { writes += on ? 1 : 2; return { ok: true }; } });
    const rWithWriter = await mgr3.start('router');
    await mgr3.stop('router');
    check('有写口时启停只经写口且意图随之落定',
      rWithWriter.ok === true && writes === 3 && emb === 0 && mgr3.get('router').desired === 'stopped',
      'writes=' + writes + ' embedded=' + emb + ' desired=' + mgr3.get('router').desired);
  }

  {
    // W1 单源：主链存活判据（进程还在 ⇒ 活着）曾在 decide/controller/upgrade-hold 三处各写一遍。
    // 现收敛为 app/main/decide 的 childAlive/adoptedAlive/targetAlive —— 此处直接钉它，
    // 因为合并本身没有既有回归保护（突变 childAlive 的 signalCode 判据时，原有测试全绿 ⇒ 判据无人看管）。
    const decide = require(path.join(ROOT, 'src', 'app', 'main', 'decide'));
    check('W1-A 单源导出：decide 提供 childAlive / adoptedAlive / targetAlive（三处调用点共用同一份）',
      typeof decide.childAlive === 'function' && typeof decide.adoptedAlive === 'function'
      && typeof decide.targetAlive === 'function', 'ok');
    const ALIVE = { exitCode: null, signalCode: null };
    const deadByCode = { exitCode: 1, signalCode: null };
    const deadBySignal = { exitCode: null, signalCode: 'SIGTERM' };
    check('W1-B childAlive：exit/signal 均未置位 ⇒ 活；任一置位 ⇒ 死；无 child ⇒ 死（不因缺对象谎报活）',
      decide.childAlive(ALIVE) === true && decide.childAlive(deadByCode) === false
      && decide.childAlive(deadBySignal) === false && decide.childAlive(null) === false,
      JSON.stringify([decide.childAlive(ALIVE), decide.childAlive(deadByCode), decide.childAlive(deadBySignal), decide.childAlive(null)]));
    const SELF = process.pid;
    check('W1-C adoptedAlive：活 pid ⇒ 活；null/undefined ⇒ 死；不存在的极大 pid ⇒ 死',
      decide.adoptedAlive(SELF) === true && decide.adoptedAlive(null) === false
      && decide.adoptedAlive(undefined) === false && decide.adoptedAlive(4000000) === false,
      JSON.stringify([decide.adoptedAlive(SELF), decide.adoptedAlive(null), decide.adoptedAlive(undefined), decide.adoptedAlive(4000000)]));
    check('W1-D targetAlive = childAlive ∨ adoptedAlive（两者皆无 ⇒ 死，不谎报活）',
      decide.targetAlive(ALIVE, null) === true && decide.targetAlive(null, SELF) === true
      && decide.targetAlive(null, null) === false,
      JSON.stringify([decide.targetAlive(ALIVE, null), decide.targetAlive(null, SELF), decide.targetAlive(null, null)]));
    // 三处调用点必须真的都走 helper（否则单源是名义的）：任一处残留手写判定都会在突变下静默漂移。
    const decSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'main', 'decide.js'), 'utf8');
    const ctlSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'main', 'controller.js'), 'utf8');
    const uhSrc = fs.readFileSync(path.join(ROOT, 'src', 'app', 'state', 'upgrade-hold.js'), 'utf8');
    const handWritten = /exitCode === null[\s\S]{0,120}?signalCode === null/g;
    const decHand = (decSrc.match(handWritten) || []).length;
    const ctlHand = (ctlSrc.match(handWritten) || []).length;
    const uhHand = (uhSrc.match(handWritten) || []).length;
    check('W1-E 三处调用点均不再手写存活判定（controller / upgrade-hold 零残留；decide 仅 helper 本体一份）',
      ctlHand === 0 && uhHand === 0 && decHand === 1,
      'controller=' + ctlHand + ' upgrade-hold=' + uhHand + ' decide=' + decHand);
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
