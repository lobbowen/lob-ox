#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// ManagedLifecycle 的**显式失败**处理（同题合并宿主：原 round13-lifecycle-stop-phase-test.js 的
//   T-a/T-b/T-c 与 原 test/lifecycle-restart-failure-test.js 的 P-a..P-e 均已并入）
//
// 缺陷 1：start()/stop() 不看回调返回的 r.ok，无条件 _setPhase('running')/('stopped') 且
//   healthy=true —— /lifecycle/status 谎报成功，面板显示运行中而服务实际是死的。
// 缺陷 2（原 round13）：stop() 失败路径硬编码 _setPhase('running')，只对「进入前确实 running」成立；
//   从 failed/backoff/installing 进入时会把**已知失败**改写成运行中，与观测相反。
// 缺陷 3：无 _restart 回调的 restart() 丢弃 stop/start 两步返回值并无条件 return {ok:true} ——
//   停不掉/起不来时仍报成功，是同一纪律的第三条出口。
//
// 锁定不变量（判据见下，一处不删）
//   K4-a  start 返回 {ok:false} -> phase 不得 running、healthy 必须 false
//   K4-b  同上 -> 返回值 ok:false 且带 error（snapshot 相位一致）
//   K4-c  start 不返回 ok 字段（历史合法形态）-> 仍视为成功（向后兼容）
//   K4-d  stop 返回 {ok:false} -> 不得置 stopped：如实回执，且相位回退到**进入前相位**
//   K4-e  回调抛异常 -> 与返回 {ok:false} 同等视为失败
//   T-a   stop 被拒后 phase 恢复为进入前相位（从 failed 进入）
//   T-b   stop 抛异常后同样恢复（从 backoff 进入）
//   T-c   对「本来是 running」的情形行为不变（仍回到 running）
//   P-a..P-e  restart() 回退路径尊重 stop/start 的显式失败（-a/-b 报 ok:false、-c 不误伤正常路径、
//             -d 尊重 _restart 回调的 {ok:false}、-e 不吞异常）
//   （原 T-d「反向：判据能识别『硬编码 running』的旧形态」已于 2026-10-01 随文本断言清理删除）
// ---------------------------------------------------------------------------

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { ManagedLifecycle } = require(path.join(ROOT, 'src', 'app', 'control', 'entry.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

(async function main() {
  // -- K4-a/b：start 显式失败 --
  {
    const lc = new ManagedLifecycle({
      id: 't1', kind: 'test', name: 'T1',
      start: async () => ({ ok: false, error: 'daemon 拉不起来' }),
      stop: async () => ({ ok: true }),
    });
    const r = await lc.start();
    check('K4-a/b start 显式失败 → phase 非 running、healthy=false，且返回 ok:false + error（snapshot 相位一致）',
      lc.phase !== 'running' && lc.healthy === false && r.ok === false && r.error === 'daemon 拉不起来'
      && lc.snapshot().phase !== 'running',
      'phase=' + lc.phase + ' healthy=' + lc.healthy + ' ' + JSON.stringify(r).slice(0, 60));
  }

  // -- K4-c：无 ok 字段的历史形态仍视为成功 --
  {
    const lc = new ManagedLifecycle({
      id: 't2', kind: 'test', name: 'T2',
      start: async () => undefined, // 老适配器可能不返回任何东西
      stop: async () => undefined,
    });
    const r = await lc.start();
    check('K4-c 无 ok 字段 → 视为成功（phase=running / healthy=true，向后兼容）',
      r.ok !== false && lc.phase === 'running' && lc.healthy === true, 'phase=' + lc.phase);
  }

  // -- T-a：从 failed 进入，stop 被拒 -> 必须回到 failed（而非硬编码 running）--
  //    「如实上报 ok:false」由 K4-d 的回执断言覆盖，此处只锁**相位恢复**这一更精确的语义。
  {
    const lc = new ManagedLifecycle({ id: 't3', stop: async () => ({ ok: false, error: 'nope' }) });
    lc._setPhase('failed'); // 输入夹具：模拟「对一个已失败模块点停止」
    await lc.stop('user');
    check('T-a stop 被拒：phase 恢复为 failed（旧实现硬编码 running）', lc.phase === 'failed', lc.phase);
  }

  // -- T-b：从 backoff 进入，stop 抛异常 -> 必须回到 backoff --
  {
    const lc = new ManagedLifecycle({ id: 't4', stop: async () => { throw new Error('boom'); } });
    lc._setPhase('backoff');
    await lc.stop('user');
    check('T-b stop 抛异常：phase 恢复为 backoff', lc.phase === 'backoff', lc.phase);
  }

  // -- K4-d / T-c：本来是 running，stop 明确失败 -> 相位与意图都不得被改写 --
  {
    const lc = new ManagedLifecycle({
      id: 't5', kind: 'test', name: 'T5',
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: false, error: '进程没死' }),
    });
    await lc.start();
    const r = await lc.stop('test');
    check('K4-d/T-c stop 显式失败 → 返回 ok:false + error；原本 running 的仍为 running、desired 不得被改写',
      r.ok === false && !!r.error && lc.phase === 'running' && lc.desired !== 'stopped',
      JSON.stringify(r).slice(0, 60) + ' phase=' + lc.phase + ' desired=' + lc.desired);
  }

  // -- K4-e：抛异常与显式失败同语义 --
  {
    const lc = new ManagedLifecycle({
      id: 't6', kind: 'test', name: 'T6',
      start: async () => { throw new Error('炸了'); },
    });
    const r = await lc.start();
    check('K4-e start 抛异常 → ok:false / phase 非 running', r.ok === false && lc.phase !== 'running', 'phase=' + lc.phase);
  }

  // -- 反向：成功路径不被误伤 --
  {
    const lc = new ManagedLifecycle({
      id: 't7', kind: 'test', name: 'T7',
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
    });
    await lc.start();
    const okStart = lc.phase === 'running' && lc.healthy === true;
    await lc.stop('test');
    check('成功路径不受影响（start→running，stop→stopped）', okStart && lc.phase === 'stopped' && lc.healthy === false,
      'phase=' + lc.phase);
  }

  // -- 幂等：已在 running/starting 时 start 直接返回 already --
  {
    const lc = new ManagedLifecycle({ id: 't8', kind: 'test', name: 'T8', start: async () => ({ ok: true }) });
    await lc.start();
    const r = await lc.start();
    check('start 幂等（已在运行 → already）', r.ok === true && r.already === true, JSON.stringify(r));
  }

  // -- P-a..P-e：restart() 回退路径（stop->start）必须尊重两步的显式失败 --
  //    夹具：与 K4 各条同源（注入 start/stop/restart 桩），故沿用最小 mk。
  const mkRestart = (o) => new ManagedLifecycle(Object.assign({
    id: 'r1', kind: 'module', name: 'r1',
    logger: { info() {}, warn() {}, error() {} },
  }, o));
  {
    // P-a stop 被拒 -> 不得无条件成功
    const lc = mkRestart({ start: async () => ({ ok: true }), stop: async () => ({ ok: false, error: '进程未退出' }) });
    lc.desired = 'running'; lc.phase = 'running';
    const r = await lc.restart();
    check('P-a stop 失败 → restart 报 ok:false（不无条件成功）', r.ok === false, JSON.stringify({ ok: r.ok, error: r.error }));
  }
  {
    // P-b stop 成功但 start 被拒 -> 报 ok:false 且指出是启动失败（不是停失败）
    const lc = mkRestart({ start: async () => ({ ok: false, error: '单元起不来' }), stop: async () => ({ ok: true }) });
    lc.desired = 'running'; lc.phase = 'running';
    const r = await lc.restart();
    check('P-b start 失败 → restart 报 ok:false 且 error 标明「启动失败」',
      r.ok === false && /启动失败/.test(String(r.error)), JSON.stringify({ ok: r.ok, error: r.error }));
  }
  {
    // P-c 两步都成功 -> ok:true 且确实走了 stop→start（正常路径不误伤）
    const seen = [];
    const lc = mkRestart({
      start: async () => { seen.push('start'); return { ok: true }; },
      stop: async () => { seen.push('stop'); return { ok: true }; },
    });
    lc.desired = 'running'; lc.phase = 'running';
    const r = await lc.restart();
    check('P-c 两步成功 → ok:true 且确实走了 stop→start（正常路径不误伤）',
      r.ok === true && seen.join(',') === 'stop,start', JSON.stringify({ ok: r.ok, seen: seen.join(',') }));
  }
  {
    // P-d 有 `_restart` 回调时优先用回调，且尊重其 {ok:false}
    let usedCb = false;
    const lc = mkRestart({
      restart: async () => { usedCb = true; return { ok: false, error: '回调明确失败' }; },
      start: async () => ({ ok: true }),
      stop: async () => ({ ok: true }),
    });
    lc.desired = 'running'; lc.phase = 'running';
    const r = await lc.restart();
    check('P-d 有回调时优先用回调，且回调 ok:false 被尊重',
      usedCb === true && r.ok === false && /回调明确失败/.test(String(r.error)), JSON.stringify({ usedCb, ok: r.ok, error: r.error }));
  }
  {
    // P-e 回退路径不吞异常：stop() 内部已 try/catch -> 返回 {ok:false}；
    //     「不抛出」与「如实报 ok:false」是同一次调用的两个侧面，合并为一条。
    const lc = mkRestart({ start: async () => ({ ok: true }), stop: async () => { throw new Error('stop 抛了'); } });
    lc.desired = 'running'; lc.phase = 'running';
    let threw = null;
    let r = null;
    try { r = await lc.restart(); } catch (e) { threw = e; }
    check('P-e stop 抛异常 → restart 不抛出且如实报 ok:false',
      threw === null && !!r && r.ok === false,
      (threw ? threw.message : '无异常') + ' ' + JSON.stringify({ ok: r && r.ok, error: r && r.error }));
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
