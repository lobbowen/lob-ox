#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// test/app-ctor-injection-test.js —— app 级「真 ctor 注入」直测（DF-6 判据）· **state 协作方**
//
// 判据：协作方模块可**只 require + 假 deps**直接断言行为，无需构造 Supervisor。
// 本文件装 **state** 切面（createStateStore：phase/desired/字段/IO + main-record fallback）与
// **control** 切面（createProjection 直调 + createControlPlane 受管申报；原
// app-control-plane-injection-test.js 已并入本文件，共用下面同一个 fakeRegistry 夹具）；
// 其余协作方按域分置（同判据、各自独立的失败语义）：持久化 fail-closed ->
// app-state-persist-failclosed-test.js；session -> app-session-injection-test.js。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const { createStateStore } = require(path.join(ROOT, 'src', 'app', 'state', 'collaborator'));
const { createProjection } = require(path.join(ROOT, 'src', 'app', 'control', 'projection'));
const { createControlPlane } = require(path.join(ROOT, 'src', 'app', 'control', 'collaborator'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctor-inj-'));
const warnLog = [];

/** 假受管目录（含真实 setPhase/update/register/unregister 语义）。 */
function fakeRegistry() {
  const entries = new Map();
  return {
    entries,
    _loadedFromDisk: false,
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    setPhase(id, ph) { const e = entries.get(id); if (e) { e.phase = ph; e.lastTransitionAt = 't'; } },
    // 与真实 registry.update 同源的关键语义：**值为 undefined 的键不改写**（沙箱申报不带
    //   desired/guardian（B2-1/B2-2）；裸 Object.assign 会抹掉，假件反而比实现更严）。
    update(id, patch) {
      const e = entries.get(id);
      if (!e) return { ok: false, error: '未注册: ' + id };
      for (const k of Object.keys(patch || {})) if (patch[k] !== undefined) e[k] = patch[k];
      return { ok: true, object: e };
    },
    register(spec) { entries.set(spec.id, Object.assign({ phase: 'stopped' }, spec)); },
    unregister(id) { entries.delete(id); },
    persistCrashState() {},
  };
}

// ---------------------------------------------------------------------------
// F8 state：createStateStore(deps) —— 自己持有 phase/desired/字段/IO 实现
// ---------------------------------------------------------------------------
{
  const reg = fakeRegistry();
  const stateFile = path.join(tmp, 'state.json');
  const state = createStateStore({
    getConfig: () => ({ stateFile }),
    getConfigPath: () => path.join(tmp, 'config.json'),
    getLogger: () => ({ warn: (m) => warnLog.push(m) }),
    getEvents: () => null,
    getManagedObjects: () => reg,
    getInstances: () => null,
    getViews: () => ({ status: () => ({ updatedAt: null }) }),
    getIntents: () => null,
    getHold: () => false, setHold() {}, getSince: () => null, setSince() {},
    getCrashHalted: () => false, setCrashHalted() {},
    getManualRestart: () => false, setManualRestart() {},
    stopProcess() {}, tick() {},
  });

  check('S2 无目录项 → fallback：phase 默认 STOPPED', state.phase() === 'STOPPED', state.phase());

  state.setPhase('RUNNING');
  check('S3/S4 setPhase 大写 → 目录 canonical running，且 phase 读回大写 RUNNING',
    state.store().phase === 'running' && state.phase() === 'RUNNING', state.store().phase + '/' + state.phase());

  state.setDesired('stopped');
  check('S5 setDesired 写目录 desired', state.store().desired === 'stopped' && state.desired() === 'stopped', state.desired());

  state.field('restartCount', 3);
  check('S6 field 写读一致', state.field('restartCount') === 3, String(state.field('restartCount')));
  state.procField('adopted', true);
  check('S7 procField 写读一致', state.procField('adopted') === true, String(state.procField('adopted')));

  state.writeMainMeta({ guardian: true, remoteToken: 'tok' });
  check('S9 main 元数据写后读同源', state.readMainMeta().guardian === true && state.readMainMeta().remoteToken === 'tok', 'ok');
  check('S10/S11 文件名派生：mainMetaFile 取自 stateFile 同目录的 dsh-main.json，registryFileName → managed-objects.json',
    state.mainMetaFile() === path.join(tmp, 'dsh-main.json') && state.registryFileName() === 'managed-objects.json',
    state.mainMetaFile() + ' / ' + state.registryFileName());

  state.persistConfigPatch({ apiAccessKey: 'k' });
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  check('S12 persistConfigPatch 原子落盘', cfg.apiAccessKey === 'k', JSON.stringify(cfg));
}

// ---------------------------------------------------------------------------
// M3（B2-3，审计 #26）：main-record fallback 是「目录未就绪期的暂存稿」，不是孤儿稿。
//   随目录持久化的字段（崩溃窗/退避/重启计数）在 fallback 期写入，必须于真 entry 首见时一次性
//   回填；目录侧带真实数据（非 createEntry 缺省）时草稿让位，绝不反向覆盖。
//   顺带钉死：fallback entry 形态不含 guardian 键（与 B2-2 同批的红线收口）。
// ---------------------------------------------------------------------------
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-fallback-'));
  const mk = (reg) => createStateStore({
    getConfig: () => ({ stateFile: path.join(t, 'state.json') }),
    getConfigPath: () => path.join(t, 'config.json'),
    getLogger: () => ({ warn() {} }),
    getEvents: () => null,
    getManagedObjects: () => reg,
    getInstances: () => null,
    getViews: () => ({ status: () => ({ updatedAt: null }) }),
    getIntents: () => null,
    getHold: () => false, setHold() {}, getSince: () => null, setSince() {},
    getCrashHalted: () => false, setCrashHalted() {},
    getManualRestart: () => false, setManualRestart() {},
    stopProcess() {}, tick() {},
  });
  check('M3a fallback entry 形态不含 guardian 键（B2-3 红线收口）',
    !('guardian' in mk(fakeRegistry()).fallbackEntry()),
    Object.keys(mk(fakeRegistry()).fallbackEntry()).join(','));

  const reg = fakeRegistry();
  const st = mk(reg);
  st.field('restartCount', 5); st.field('backoffLevel', 2); st.field('backoffUntil', 999);
  st.field('crashWindowStart', 1234); st.field('crashWindowRestarts', 4);
  check('M3a 未就绪期草稿写读一致',
    st.field('restartCount') === 5 && st.field('crashWindowStart') === 1234, 'fallback 直读');
  // 真 entry 出现（计数=createEntry 缺省零值）-> 首见即回填（审计缺陷的正面反证）。
  reg.register({ kind: 'dsh', id: 'main', desired: 'running',
    restartCount: 0, backoffLevel: 0, backoffUntil: null, crashWindowStart: null, crashWindowRestarts: 0 });
  const e = st.store();
  check('M3b 真 entry 首见即回填（目录未就绪期计数不再静默丢失）',
    e.restartCount === 5 && e.backoffLevel === 2 && e.backoffUntil === 999
    && e.crashWindowStart === 1234 && e.crashWindowRestarts === 4,
    'r=' + e.restartCount + ' bl=' + e.backoffLevel + ' bu=' + e.backoffUntil);
  // 草稿让位盘上真实数据：entry 侧非缺省值（7）时回填绝不压制它。
  const reg3 = fakeRegistry();
  const st3 = mk(reg3);
  st3.field('restartCount', 5);                                                // 草稿期写 5
  reg3.register({ kind: 'dsh', id: 'main', desired: 'running', restartCount: 7 }); // 目录真实计数 7
  check('M3c 目录侧真实计数优先（回填仅在缺省位，草稿不反向覆盖）',
    st3.store().restartCount === 7, 'r=' + st3.store().restartCount);
}

// ---------------------------------------------------------------------------
// F6/F7 control：createProjection 直调（P1-P3）+ createControlPlane 申报面（原
//   test/app-control-plane-injection-test.js 并入：同判据、复用上面同一个 fakeRegistry）。
//   判据（DF-6）：协作方可只 require + 假 deps 直接断言，无需构造 Supervisor。
//   不变量：P4 sandboxSpec 不含 desired（B2-1）/guardian（B2-2）；P9 目录申报项一律零持 guardian 键；
//   D-8 观测/启动对齐路径对沙箱目录的 desired 零写权（旧形态会把 BACKOFF 实然相位反推成意图，
//   或从 inst.state.desired 投影出无消费者的空转字段）。
// ---------------------------------------------------------------------------
{
  const reg = fakeRegistry();
  reg.register({ kind: 'dsh', id: 'main', desired: 'running', phase: 'running' });
  const lcMap = new Map();
  const mkLc = (id) => ({ id, desired: 'stopped', phase: 'stopped', _monitoring: false, _setPhase(p) { this.phase = p; }, wantRunning() { this.desired = 'running'; } });
  const routerLc = mkLc('router'); routerLc.desired = 'running'; lcMap.set('router', routerLc);
  lcMap.set('instances', mkLc('instances'));
  lcMap.set('dsh', mkLc('dsh'));
  const mgr = { get: (id) => lcMap.get(id) };
  const ctlState = {
    dshEntry: () => reg.get('main'),
    phase: () => 'RUNNING',
    desired: () => 'running',
    guardian: () => true,
    readMainMeta: () => ({ guardian: true }),
  };
  const control = createControlPlane({
    getLifecycleManager: () => mgr,
    getState: () => ctlState,
    getManagedObjects: () => reg,
    getInstances: () => ({ instances: [], sandboxRoot: (i) => '/root/' + i.id }),
    getConfig: () => ({ targetPort: 3080, routerAutostart: true }),
    getCtl: () => ({ routerPort: () => 43107, lanPort: () => 43108 }),
    getDaemons: () => ({ enabled: () => false }),
    getLogger: () => ({ info() {}, warn() {} }),
  });

  // P1-P3 落点 = createProjection 的**直接调用面**：投影是独立协作方，只经 createControlPlane
  //   转发会让 createProjection 在测试里零引用（删掉 app-control-plane 后全仓 0 引用的缺口）。
  const projection = createProjection({ getLifecycleManager: () => mgr, getState: () => ctlState, getManagedObjects: () => reg });
  projection.syncInstancesView();
  projection.syncRouterView({ ok: true });
  projection.syncDshView();
  check('P1/P2 createProjection 直调：instances/router 视图 running + healthy',
    lcMap.get('instances').phase === 'running' && lcMap.get('instances').healthy === true
    && lcMap.get('router').phase === 'running' && lcMap.get('router').healthy === true,
    lcMap.get('instances').phase + ' / ' + lcMap.get('router').phase);
  check('P3 createProjection 直调：dsh 视图 running + guardian 同源 state.guardian()',
    lcMap.get('dsh').phase === 'running' && lcMap.get('dsh').guardian === true, lcMap.get('dsh').phase);

  // B2-1/B2-2：desired 一旦进沙箱申报，实例崩进 BACKOFF 时实然观测会被反推成意图；
  //   guardian 进申报 = 出现第二权威源（域记录才是权威源）。
  const spec = control.sandboxSpec({ id: 's1', name: '沙箱', port: 3900, state: { phase: 'RUNNING' }, guardian: true });
  check('P4 sandboxSpec 不含 desired（B2-1）也不含 guardian（B2-2），且 unit/rootPath 就位（P5 并入）',
    spec && !('desired' in spec) && !('guardian' in spec)
    && spec.ownership.unit === 'dsh-web@s1' && spec.ownership.rootPath === '/root/s1',
    'keys=' + Object.keys(spec || {}).join(','));
  control.upsert(spec);
  const upserted = !!reg.get('s1');
  control.unregister('s1');
  check('P6/P7 upsert 注册沙箱实例 / unregister 注销', upserted && !reg.get('s1'), 'upserted=' + upserted);

  reg.unregister('main'); // main 交给 syncManagedRegistry 重新申报
  control.syncManagedRegistry();
  // P8（`keys.join(',') === 'lan-daemon,main,router-daemon'` 簿记名单精确值）已删：
  //   申报存在性由 P9 的 reg.get(k) 蕴含，逐字名单属内部形态。
  check('P9 B2-2 目录申报项一律无 guardian 键（main/router-daemon/lan-daemon，域记录才是权威源）',
    ['main', 'router-daemon', 'lan-daemon'].every((k) => reg.get(k) && !('guardian' in reg.get(k))),
    ['main', 'router-daemon', 'lan-daemon'].map((k) => k + ':' + (reg.get(k) ? Object.keys(reg.get(k)).join('/') : '缺')).join(' | '));

  // -- D-8：沙箱不申报 desired（B2-1 的第二落点）也不申报 guardian（B2-2 目录面零持键）--
  //   旧形态一：desired 由 inst.state.phase 反推 => 实例一崩进 BACKOFF，意图被观测改写。
  //   旧形态二（ST-2c）：desired 取 inst.state.desired 投影 => 无决策消费者，纯空转字段。
  //   收口后 spec 不含 desired、registry.update 见 undefined 即跳过 —— 观测/启动对齐对沙箱目录
  //   的 desired 彻底没有写权。夹具接线教训：观测对象必须与被测对象**同一引用**，取值先落地成变量。
  {
    const d8 = reg;                                           // 与 control 的 getManagedObjects 同一引用
    const ent = (id) => (d8.get(id) || { __absent: true });   // 未登记 -> 判红，不抛
    const sb = (over) => Object.assign({ id: 'd8', name: '沙箱', port: 3901, guardian: false }, over);
    control.upsert(control.sandboxSpec(sb({ state: { phase: 'RUNNING', desired: 'running' } })));
    // 假件 register 直通 spec（真实 registry 的 createEntry 缺省归一由 managed-registry-test 单独钉）。
    control.upsert(control.sandboxSpec(sb({ name: '改名', state: { phase: 'BACKOFF', desired: 'stopped' } })));
    check('D-8 行为：残留意图翻成 stopped + BACKOFF 观测，裸 upsert 仍不写 desired，name 照常刷新',
      ent('d8').desired === undefined && ent('d8').name === '改名',
      'desired=' + ent('d8').desired + ' name=' + ent('d8').name);

    // 启动对齐（syncManagedRegistry 逐实例 upsert）：load() 后的 state.phase 只是实然快照；
    //   沙箱 spec 不带 desired，对齐刷新永远碰不到目录里的应然意图。
    const d8boot = fakeRegistry();
    const bootInst = { id: 'boot1', name: '沙箱', port: 3903, guardian: false, state: { phase: 'BACKOFF', desired: 'running' } };
    const ctlBoot = createControlPlane({
      getLifecycleManager: () => ({ get: () => null }),
      getState: () => ctlState,
      getManagedObjects: () => d8boot,
      getInstances: () => ({ all: () => [bootInst], sandboxRoot: (i) => '/root/' + i.id }),
      getConfig: () => ({ targetPort: 3080, routerAutostart: true }),
      getCtl: () => ({ routerPort: () => 43107, lanPort: () => 43108 }),
      getDaemons: () => ({ enabled: () => false }),
      getLogger: () => ({ info() {}, warn() {} }),
    });
    const ent2 = (id) => (d8boot.get(id) || {});
    ctlBoot.syncManagedRegistry();
    ent2('boot1').desired = 'stale';
    ent2('boot1').name = '旧名';
    bootInst.name = '新名';
    ctlBoot.syncManagedRegistry();
    check('D-8 行为：启动对齐照常刷新其余应然（name 随申报更新），同一次刷新不改写目录 desired（观测路径对意图零写权）',
      ent2('boot1').name === '新名' && ent2('boot1').desired === 'stale',
      'name=' + ent2('boot1').name + ' desired=' + ent2('boot1').desired);
    check('D-8 边界：两个 daemon 的 desired 仍由 config 驱动（routerAutostart=true → running / 未启用 → stopped）',
      ent2('router-daemon').desired === 'running' && ent2('lan-daemon').desired === 'stopped',
      String(ent2('router-daemon').desired) + ' / ' + String(ent2('lan-daemon').desired));
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
