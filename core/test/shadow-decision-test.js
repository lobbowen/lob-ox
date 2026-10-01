#!/usr/bin/env node
'use strict';

// 真实门 supervisor.js::_shouldRun() 有三个否决位（desired !== 'running' / _sessionHalting() / _crashHalted），影子 _decideMainAction() 只建模第一个 ⇒ 崩溃停靠时真实 tick 不拉起、影子算出 start ⇒ 每拍 diff，切换门槛（连续零 diff）永久不可达。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const decideMod = require(path.join(ROOT, 'src', 'app', 'main', 'decide.js'));
const decide = decideMod.methods._decideMainAction;

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const base = () => ({
  phase: 'STOPPED', desired: 'running',
  probeOk: false, probeHttpOk: false,
  childAlive: false, adoptedAlive: false, adoptedPidSet: false, childPresent: false,
  adopted: false, observedOnly: false,
  upgradeHold: false, manualRestart: false, spawnBlocked: false,
  startDeadlinePassed: false, restartDue: true, backoffDue: true,
  crashHalted: false, sessionHalting: false,
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
  const s = base(); s.crashHalted = true; s.probeOk = true;
  const r = decide(s);
  check('K5-c crashHalted 优先于 probeOk（不得 adopt）', r.action !== 'start' && r.action !== 'adopt', JSON.stringify(r));
}

{
  const s = base(); s.desired = 'stopped'; s.childAlive = true;
  const r = decide(s);
  check('desired=stopped 仍优先给出 stop', r.action === 'stop', JSON.stringify(r));
}

{
  const s = base(); s.probeOk = true;
  const r = decide(s);
  check('无否决位 + probeOk → adopt（原有分支未被破坏）', r.action === 'adopt', JSON.stringify(r));
}

{
  const f = decideMod.startDeadlinePassed;
  check('deadline 缺失一律未到期（从盘恢复不得当场杀在途启动）',
    f(null, Date.now() + 1e9) === false && f(undefined, 0) === false, 'null/undefined');
  check('now 严格大于 deadline 才判到期',
    f(1000, 1001) === true && f(1000, 1000) === false, '边界');
  const s = base(); s.phase = 'STARTING'; s.startDeadlinePassed = true;
  const r = decide(s);
  check('STARTING + 判据到期 → restart 且计崩溃（countCrash）',
    r.action === 'restart' && r.countCrash === true, JSON.stringify(r));
  const s2 = base(); s2.phase = 'STARTING';
  const r2 = decide(s2);
  check('STARTING + 未到期 → none（不误计崩溃）', r2.action === 'none', JSON.stringify(r2));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);