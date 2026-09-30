#!/usr/bin/env node
'use strict';

// 阶段 1「所有权归一」契约回归（ARCHITECTURE-CONTRACT-phase0）：
//   INV-X1 守卫内核不得 systemctl stop/restart 自己所属单元 · INV-S1 stopping/stopped 期间抑制
//   一切自动拉起 · INV-S2 退出唯一入口 shutdownAll · INV-S4 会话态唯一读取口 sessionState()。
// 自包含：构造最小 Supervisor（TMP stateFile，不 start 定时器），不触碰生产文件。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  // -- 2) 会话状态机基础 --
  console.log('== 会话状态机（契约 §3）==');
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const cfg = {
    command: ['node', '-e', '0'],
    healthUrl: 'http://127.0.0.1:28181/',
    probeIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28180,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'up.log'),
  };
  const sup = new Supervisor(cfg);
  check('会话态初始 = starting', sup.sessionState() === 'starting', sup.sessionState());

  // -- 3) INV-S1：stopping 期间抑制自动拉起 --
  console.log('== INV-S1 stopping 抑制拉起 ==');
  let spawned = 0;
  sup._startProcess = async () => { spawned++; sup._mSetPhase('STARTING'); };
  // 放行门：desired=running + 显式 start 意图（守护关也能拉起）
  sup._mSetDesired('running');
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  const spawnedWhenRunning = spawned;
  check('running 会话态：显式意图可触发拉起', spawnedWhenRunning >= 1, 'spawned=' + spawnedWhenRunning);

  // 进入 stopping -> 同一条件下必须抑制
  spawned = 0;
  sup._setSessionState('stopping');
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  check('INV-S1 stopping 期间抑制拉起（spawned=0）', spawned === 0, 'spawned=' + spawned);

  // -- 4) 退出：shutdownAll 置 stopped 且幂等 --
  console.log('== 退出（契约 §4.1）==');
  sup._setSessionState('running'); // 复位（上一步 INV-S1 测试停在 stopping）
  const r1 = await sup.shutdownAll();
  check('shutdownAll → 回执 ok/sessionState=stopped、会话态 stopped、_sessionHalting() 生效',
    r1 && r1.ok === true && r1.sessionState === 'stopped' && sup.sessionState() === 'stopped' && sup._sessionHalting() === true, JSON.stringify(r1));
  check('退出后 shellHalted 跨守卫重启继承且 statusSummary 暴露（抑制看护）',
    sup.statusSummary().shellHalted === true, JSON.stringify(sup.statusSummary().shellHalted));
  const r2 = await sup.shutdownAll();
  check('shutdownAll 幂等（already 回执）', r2 && r2.ok === true && r2.already === true && r2.sessionState === 'stopped', JSON.stringify(r2));

  // stopped 期间仍抑制
  spawned = 0;
  sup.intents.register('start');
  sup._mSetPhase('STOPPED');
  await sup.tick();
  check('INV-S1 stopped 期间同样抑制拉起', spawned === 0, 'spawned=' + spawned);

  // -- 4b) 阶段 2 意图单源：desired 是恢复权威--
  console.log('== 阶段 2 意图单源（恢复语义）==');
  {
    const s2 = new Supervisor(cfg);
    s2._startProcess = async () => { spawned++; s2._mSetPhase('STARTING'); };
    // 场景 A：守卫重启后 desired=running + guardian=false（默认关，无 hook 可设）+ 无内存意图 -> 必须拉起
    spawned = 0;
    s2._mSetDesired('running');
    s2._setSessionState('running');
    s2._mSetPhase('STOPPED');
    s2.intents.clear(); // 无显式意图（模拟重启后内存态为空）
    await s2.tick();
    check('P2-A desired=running+guardian=false+无意图 → 拉起（恢复语义）', spawned >= 1, 'spawned=' + spawned);

    // 场景 B：desired=stopped -> 绝不拉起
    spawned = 0;
    s2._mSetDesired('stopped');
    s2._setSessionState('running');
    s2._mSetPhase('STOPPED');
    s2.intents.clear();
    await s2.tick();
    check('P2-B desired=stopped → 不拉起', spawned === 0, 'spawned=' + spawned);

    // 场景 C：未守护崩溃 -> 停靠；下一拍（desired 仍 running）不得自动拉起
    spawned = 0;
    s2._mSetDesired('running');
    s2._setSessionState('running');
    s2._crashHalted = true; // 模拟未守护崩溃停靠
    s2._mSetPhase('STOPPED');
    s2.intents.clear();
    await s2.tick();
    check('P2-C 未守护崩溃停靠后不自动拉起（guardian 语义保留）', spawned === 0, 'spawned=' + spawned);

    // 场景 D：显式启动清除停靠 -> 拉起（setDesired 内部自带 tick；等其结算）
    spawned = 0;
    s2._mSetDesired('stopped');
    s2._crashHalted = true;
    s2._mSetPhase('STOPPED');
    s2.setDesired('running'); // 显式启动：清停靠 + 注册意图 + 触发 tick
    await new Promise((r) => setTimeout(r, 80)); // 等内部 tick 结算（_ticking 守卫下 await tick 会空跑）
    check('P2-D 显式启动清除崩溃停靠标记并拉起', s2._crashHalted === false && spawned >= 1,
      'halted=' + s2._crashHalted + ' spawned=' + spawned);
  }

  // -- 5) 6) /session API 契约 --
  console.log('== /session API ==');
  const lifecycleApi = require(path.join(ROOT, 'src', 'api', 'domains', 'lifecycle'));
  check('lifecycle.owns 覆盖 /session/status 与 /session/stop',
    lifecycleApi.owns('/session/status') === true && lifecycleApi.owns('/session/stop') === true);

  // -- 7) 阶段 3：会话态贯通（statusSummary / 全域抑制）--
  console.log('== 阶段 3 会话态贯通 ==');
  {
    const s3 = new Supervisor(cfg);
    check('P3-G shellHalted 跨守卫重启继承（新守卫读回）', s3.statusSummary().shellHalted === true, String(s3.statusSummary().shellHalted));
    const snap = s3.statusSummary();
    check('P3-A statusSummary 暴露 sessionState', snap.sessionState === 'starting', JSON.stringify(snap.sessionState));
    s3._setSessionState('stopping');
    check('P3-B sessionState 随迁移更新', s3.statusSummary().sessionState === 'stopping', s3.statusSummary().sessionState);

    // INV-S1 全域：沙箱 / daemon supervise 在 halting 时短路
    let sandboxTouched = false, daemonTouched = false;
    s3.instances = { supervise: async () => { sandboxTouched = true; }, probeInstance: () => ({ running: true }) };
    s3._syncSandboxRegistryEntry = () => {};
    const sr = await s3._sandboxSuperviseOnce({ id: 'inst-x' });
    check('P3-C stopping 期间沙箱 supervise 短路（INV-S1 全域）', sr && sr.ok === false && sandboxTouched === false, JSON.stringify(sr));
    const dr = await s3._daemonSuperviseOnce('router');
    check('P3-D stopping 期间 daemon supervise 短路（INV-S1 全域）', dr && dr.ok === false && daemonTouched === false, JSON.stringify(dr));
  }

  // -- 8) 阶段 4 的事件读适配器（P4-C/D/E）已迁入 loghub-test.js（与 EventHub 同源语义）--

  // -- 9) P2：B1 能力元数据执法 + ST-1 启停写口 --
  console.log('== P2 B1 能力执法 ==');
  {
    const { LifecycleManager } = require(path.join(ROOT, 'src', 'app', 'control', 'manager'));
    const { registerAll } = require(path.join(ROOT, 'src', 'app', 'control', 'adapters'));
    let emb = 0, writes = 0; // 本文件自备的「内嵌 router 被直调」与「写口被调」计数
    // 三个夹具唯一差异是 supervisor 写口，故抽一个装配工厂（原先逐字三份）。
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
    check('B1-a/b 可启停模块 startable=true（dsh/router/lan）；聚合模块（instances/plugins）startable=false',
      ['dsh', 'router', 'lan'].every((id) => mgr.get(id).startable === true)
        && ['instances', 'plugins'].every((id) => mgr.get(id).startable === false), 'ok');
    check('B1-c/d guardable=false → guardian 锁定 false，且 snapshot 暴露 startable/guardable',
      mgr.get('plugins').guardable === false && mgr.get('plugins').guardian === false
        && mgr.get('plugins').snapshot().startable === false && mgr.get('router').snapshot().startable === true, 'ok');
    const r1 = await mgr.start('plugins');
    const r2 = await mgr.stop('instances');
    const r3 = await mgr.restart('plugins');
    check('B1-e 不可启停模块 start/stop/restart 被拒（非假成功）',
      r1.ok === false && r2.ok === false && r3.ok === false && /不可启停/.test(r1.error || ''), JSON.stringify(r1));
    check('B1-f 可启停模块仍放行', (await mgr.start('router')).ok === true, 'ok');

    // ST-1 写侧：router 启停唯一写口是 setRouterRunning（同时落 config.routerAutostart）；缺写口必须
    //   显式拒绝，且不得把 running 意图留在视图上 —— 否则读侧出现第二真相，被停掉的 daemon 被无限重拉。
    emb = 0;
    const mgr2 = mkMgr({});
    const rNoWriter = await mgr2.start('router');
    check('ST-1 缺 setRouterRunning 写口时 start 被拒（非假成功）', rNoWriter.ok === false && /setRouterRunning/.test(rNoWriter.error || ''), JSON.stringify(rNoWriter).slice(0, 90));
    check('ST-1 被拒的 start 不留 running 意图且不绕过持久化直调内嵌 router',
      mgr2.get('router').desired !== 'running' && emb === 0, 'desired=' + mgr2.get('router').desired + ' embedded=' + emb);
    // 反向对照：同一 adapter 换上带写口的 supervisor，启停只经写口、内嵌 router 零直调。
    emb = 0;
    const mgr3 = mkMgr({ setRouterRunning: async (on) => { writes += on ? 1 : 2; return { ok: true }; } });
    const rWithWriter = await mgr3.start('router');
    await mgr3.stop('router');
    check('ST-1 有写口时启停只经写口且意图随之落定',
      rWithWriter.ok === true && writes === 3 && emb === 0 && mgr3.get('router').desired === 'stopped',
      'writes=' + writes + ' embedded=' + emb + ' desired=' + mgr3.get('router').desired);
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
