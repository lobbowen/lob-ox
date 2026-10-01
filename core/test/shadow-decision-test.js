#!/usr/bin/env node
'use strict';

// 声明式决策面必须与真实 tick（app/main/controller.js）同一套判据：
// 存活 = 进程还在（childAlive / adoptedAlive）；端口视角（portUp）只决定孤儿接管/占用，不再是健康门。
// 相位集合收敛为 STOPPED / STARTING / RUNNING / FAILED：没有 RESTARTING/BACKOFF，也没有 countCrash。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const decideMod = require(path.join(ROOT, 'src', 'app', 'main', 'decide.js'));
const decide = decideMod.methods._decideMainAction;

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const base = () => ({
  phase: 'STOPPED', desired: 'running',
  portUp: false,
  childAlive: false, adoptedAlive: false, adoptedPidSet: false, childPresent: false,
  adopted: false, observedOnly: false,
  upgradeHold: false, manualRestart: false, spawnBlocked: false,
  startDeadlinePassed: false, restartInFlight: false, restartDue: true,
  crashHalted: false, sessionHalting: false,
  startupFailWindowStart: null, startupFailCount: 0,
});

{
  const r = decide(base());
  check('K5-d 无否决位 → action=start（防修成永不拉起）', r.action === 'start', JSON.stringify(r));
}

{
  const s = base(); s.crashHalted = true;
  const r = decide(s);
  check('K5-a crashHalted → 不得 start（与 _shouldRun 一致）', r.action !== 'start', JSON.stringify(r));
}

{
  const s = base(); s.sessionHalting = true;
  const r = decide(s);
  check('K5-b sessionHalting → 不得 start', r.action !== 'start', JSON.stringify(r));
}

{
  const s = base(); s.crashHalted = true; s.portUp = true;
  const r = decide(s);
  check('K5-c crashHalted 优先于端口占用（不得 adopt）', r.action !== 'start' && r.action !== 'adopt', JSON.stringify(r));
}

{
  const s = base(); s.desired = 'stopped'; s.childAlive = true;
  const r = decide(s);
  check('desired=stopped 仍优先给出 stop', r.action === 'stop', JSON.stringify(r));
}

{
  const s = base(); s.portUp = true;
  const r = decide(s);
  check('无否决位 + 端口有主 → adopt（孤儿接管分支保留）', r.action === 'adopt', JSON.stringify(r));
}

{
  const f = decideMod.startDeadlinePassed;
  check('deadline 缺失一律未到期（从盘恢复不得当场杀在途启动）',
    f(null, Date.now() + 1e9) === false && f(undefined, 0) === false, 'null/undefined');
  check('now 严格大于 deadline 才判到期',
    f(1000, 1001) === true && f(1000, 1000) === false, '边界');
}

{
  // STARTING = 仍在 startsecs 窗口内：到点且进程或活 ⇒ RUNNING；不再有 start_timeout 崩溃记账。
  const s = base(); s.phase = 'STARTING'; s.childAlive = true; s.childPresent = true; s.startDeadlinePassed = true;
  const r = decide(s);
  check('STARTING + 窗口到点 + 进程或活 → enterRunning（无健康门、无 countCrash）',
    r.action === 'enterRunning' && r.countCrash === undefined, JSON.stringify(r));
  const s2 = base(); s2.phase = 'STARTING'; s2.childAlive = true; s2.childPresent = true;
  const r2 = decide(s2);
  check('STARTING + 未到点 + 进程或活 → none（窗口内静默等待）', r2.action === 'none', JSON.stringify(r2));
  const s3 = base(); s3.phase = 'STARTING';
  const r3 = decide(s3);
  check('STARTING + 无进程 + 落点到 → start（重启即回到 STARTING 再 spawn）',
    r3.action === 'start' && r3.reason === 'restart_spawn', JSON.stringify(r3));
  const s4 = base(); s4.phase = 'STARTING'; s4.restartDue = false;
  check('STARTING + 无进程 + 未到落点 → none（等端口释放）', decide(s4).action === 'none', JSON.stringify(decide(s4)));
}

{
  // RUNNING：只有「进程退出」才是重启判据（活过 startsecs，属正常重启，不记启动失败）。
  const s = base(); s.phase = 'RUNNING'; s.childPresent = true; s.childAlive = false;
  const r = decide(s);
  check('RUNNING + child 已退出 → restart/adopted 语义（正常重启，不计启动失败）',
    r.action === 'restart' && r.reason === 'child_exit' && r.startupFailure === false, JSON.stringify(r));
  const s2 = base(); s2.phase = 'RUNNING'; s2.childPresent = true; s2.childAlive = true;
  check('RUNNING + 进程还在（哪怕端口不通/很忙）→ none（不看端口、不做健康门）',
    decide(s2).action === 'none', JSON.stringify(decide(s2)));
}

{
  // FAILED = 限流停靠：无人干预不重启；人工重试（manualRestart）回到 STARTING。
  const s = base(); s.phase = 'FAILED'; s.startupFailCount = 5;
  const r = decide(s);
  check('FAILED + 无干预 → none（停止自动重启，不是无限重试）',
    r.action === 'none' && r.reason === 'startup_failed_halted', JSON.stringify(r));
  const s2 = base(); s2.phase = 'FAILED'; s2.manualRestart = true;
  const r2 = decide(s2);
  check('FAILED + 人工重试 → start（清计数后回到 STARTING）', r2.action === 'start', JSON.stringify(r2));
}

{
  const s = base(); s.phase = 'RUNNING'; s.manualRestart = true; s.childAlive = true; s.childPresent = true;
  const r = decide(s);
  check('RUNNING 下的人工重启标记仍是 restart（manual）', r.action === 'restart' && r.manual === true, JSON.stringify(r));
  const s2 = base(); s2.phase = 'STARTING'; s2.manualRestart = true; s2.childAlive = true;
  check('STARTING 下的人工重启不当作启动失败（manual 标记）',
    decide(s2).action === 'restart' && decide(s2).manual === true, JSON.stringify(decide(s2)));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
