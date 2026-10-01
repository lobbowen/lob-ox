#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { ManagedLifecycle } = require(path.join(ROOT, 'src', 'app', 'control', 'entry.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

(async function main() {
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

  {
    const lc = new ManagedLifecycle({ id: 't3', stop: async () => ({ ok: false, error: 'nope' }) });
    lc._setPhase('failed'); // 输入夹具：模拟「对一个已失败模块点停止」
    await lc.stop('user');
    check('T-a stop 被拒：phase 恢复为 failed', lc.phase === 'failed', lc.phase);
  }

  {
    const lc = new ManagedLifecycle({ id: 't4', stop: async () => { throw new Error('boom'); } });
    // 夹具相位由 'backoff' 改为 'draining'：U-5 已把 'backoff' 从 PHASES 删除（等级退避不再存在），
    // 'draining' 是 stop() 内部真实用到的可恢复相位，断言意图（stop 抛异常 → 相位回滚到原相位）不变。
    lc._setPhase('draining');
    await lc.stop('user');
    check('T-b stop 抛异常：phase 恢复为 stop 前的相位（draining）', lc.phase === 'draining', lc.phase);
  }

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

  {
    const lc = new ManagedLifecycle({
      id: 't6', kind: 'test', name: 'T6',
      start: async () => { throw new Error('炸了'); },
    });
    const r = await lc.start();
    check('K4-e start 抛异常 → ok:false / phase 非 running', r.ok === false && lc.phase !== 'running', 'phase=' + lc.phase);
  }

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

  {
    const lc = new ManagedLifecycle({ id: 't8', kind: 'test', name: 'T8', start: async () => ({ ok: true }) });
    await lc.start();
    const r = await lc.start();
    check('start 幂等（已在运行 → already）', r.ok === true && r.already === true, JSON.stringify(r));
  }

  const mkRestart = (o) => new ManagedLifecycle(Object.assign({
    id: 'r1', kind: 'module', name: 'r1',
    logger: { info() {}, warn() {}, error() {} },
  }, o));
  {
    const lc = mkRestart({ start: async () => ({ ok: true }), stop: async () => ({ ok: false, error: '进程未退出' }) });
    lc.desired = 'running'; lc.phase = 'running';
    const r = await lc.restart();
    check('P-a stop 失败 → restart 报 ok:false（不无条件成功）', r.ok === false, JSON.stringify({ ok: r.ok, error: r.error }));
  }
  {
    const lc = mkRestart({ start: async () => ({ ok: false, error: '单元起不来' }), stop: async () => ({ ok: true }) });
    lc.desired = 'running'; lc.phase = 'running';
    const r = await lc.restart();
    check('P-b start 失败 → restart 报 ok:false 且 error 标明「启动失败」',
      r.ok === false && /启动失败/.test(String(r.error)), JSON.stringify({ ok: r.ok, error: r.error }));
  }
  {
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
