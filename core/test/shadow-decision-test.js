#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 影子决策与真实拉起门的一致性
//
// 真实拉起门 `supervisor.js::_shouldRun()` 有三个否决位：desired !== 'running' /
//   _sessionHalting() / _crashHalted；而影子的 `_decideMainAction()` 只建模了第一个 ->
//   guardian=false 崩溃停靠时真实 tick 不拉起、影子算出 start -> 每拍 diff ->
//   **G3 切换门槛（连续零 diff）永久不可达**。
//
// 锁定不变量：K5-a crashHalted 不得 start · K5-b sessionHalting 不得 start ·
//   K5-c 否决位优先于 probeOk（不得 adopt）· K5-d 无否决位仍能 start（防修成永不拉起）。
// ---------------------------------------------------------------------------

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
//  步骤7：converge-view.js 拆为 app/main/{decide,controller,shadow}.js，
//   导出形态从「属性描述符」改为 `{ methods }`（STEP7-INTERFACE-CONTRACT）。
const decideMod = require(path.join(ROOT, 'src', 'app', 'main', 'decide.js'));
const decide = decideMod.methods._decideMainAction;

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 基线快照：desired=running / phase=STOPPED / 无任何否决位
const base = () => ({
  phase: 'STOPPED', desired: 'running',
  probeOk: false, probeHttpOk: false,
  childAlive: false, adoptedAlive: false, adoptedPidSet: false, childPresent: false,
  adopted: false, observedOnly: false,
  upgradeHold: false, manualRestart: false, spawnBlocked: false,
  startDeadlinePassed: false, restartDue: true, backoffDue: true,
  crashHalted: false, sessionHalting: false,
});

// -- K5-d 基线：无否决位 -> 应当 start --
{
  const r = decide(base());
  check('K5-d 无否决位 → action=start（防修成永不拉起）', r.action === 'start', JSON.stringify(r));
}

// -- K5-a crashHalted --
{
  const s = base(); s.crashHalted = true;
  const r = decide(s);
  check('K5-a crashHalted → 不得 start（与 _shouldRun 一致）', r.action !== 'start', JSON.stringify(r));
}

// -- K5-b sessionHalting --
{
  const s = base(); s.sessionHalting = true;
  const r = decide(s);
  check('K5-b sessionHalting → 不得 start', r.action !== 'start', JSON.stringify(r));
}

// -- K5-c 否决位优先于 probeOk --
{
  const s = base(); s.crashHalted = true; s.probeOk = true;
  const r = decide(s);
  check('K5-c crashHalted 优先于 probeOk（不得 adopt）', r.action !== 'start' && r.action !== 'adopt', JSON.stringify(r));
}

// -- 反向：desired=stopped 仍优先（不应被新分支破坏）--
{
  const s = base(); s.desired = 'stopped'; s.childAlive = true;
  const r = decide(s);
  check('desired=stopped 仍优先给出 stop', r.action === 'stop', JSON.stringify(r));
}

// -- 反向：无否决位时的 adopt 路径仍在 --
{
  const s = base(); s.probeOk = true;
  const r = decide(s);
  check('无否决位 + probeOk → adopt（原有分支未被破坏）', r.action === 'adopt', JSON.stringify(r));
}

// -- B1-3：STARTING 超时判据单源（纯谓词 + 影子决策消费同一条）--
{
  const f = decideMod.startDeadlinePassed;
  check('B1-3 deadline 缺失一律未到期（从盘恢复不得当场杀在途启动）',
    f(null, Date.now() + 1e9) === false && f(undefined, 0) === false, 'null/undefined');
  check('B1-3 now 严格大于 deadline 才判到期',
    f(1000, 1001) === true && f(1000, 1000) === false, '边界');
  const s = base(); s.phase = 'STARTING'; s.startDeadlinePassed = true;
  const r = decide(s);
  check('B1-3 STARTING + 判据到期 → restart 且计崩溃（countCrash）',
    r.action === 'restart' && r.countCrash === true, JSON.stringify(r));
  const s2 = base(); s2.phase = 'STARTING';
  const r2 = decide(s2);
  check('B1-3 STARTING + 未到期 → none（不误计崩溃）', r2.action === 'none', JSON.stringify(r2));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);