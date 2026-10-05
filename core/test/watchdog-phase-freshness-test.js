#!/usr/bin/env node
'use strict';

// expectedAbsence() 只要 identity.phase 是 restarting/shell-update-* 就恒真，宽限期永远走 updateGraceMs（5min）而非 graceMs（90s），而 phase 唯一复位点是壳成功启动 ⇒ 壳更新中途崩溃后自愈被拖慢数倍；监控须自己计时。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { createShellWatchdog } = require(path.join(ROOT, 'src', 'domains', 'shell', 'watchdog.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const mk = (opts) => {
  const o = opts || {};
  let t = 1000000;
  let identity = o.identity;
  const calls = { restarts: [] };
  const deps = {
    shell: {
      identity: () => identity,
      readJournal: () => (o.journal || { to: null, confirmed: false }),
      restartShell: async (a) => { calls.restarts.push(a); return { ok: true, pid: 4321, exe: a.exePath }; },
    },
    pidlookup: { pgrepList: () => (o.alive ? [{ pid: 999, cmdline: '/usr/bin/lobox-shell' }] : []) },
    desktop: { sessionAvailable: () => true, describe: () => ({ available: true, reason: 'test' }) },
    logger: { info() {}, warn() {} },
    events: { append() {} },
    config: Object.assign({ shellWatchdogGraceMs: 1000, shellWatchdogUpdateGraceMs: 5000 }, o.config || {}),
    now: () => t,
  };
  const w = createShellWatchdog(deps);
  return { w, calls, adv: (ms) => { t += ms; }, setIdentity: (v) => { identity = v; } };
};

const GUI = '/usr/bin/lobox-shell';

(async () => {
  {
    const m = mk({ alive: false, identity: { phase: 'shell-update-download', exe: GUI } });
    await m.w.tick();
    m.adv(1200);               // 超 graceMs(1000) 但未到 updateGraceMs(5000)
    await m.w.tick();
    check('N-a 新鲜更新相位 → 不拉起（宽限延长）且 expectedAbsence=true',
      m.calls.restarts.length === 0 && m.w.status().expectedAbsence === true, 'restarts=' + m.calls.restarts.length);
  }

  {
    const m = mk({
      alive: false,
      identity: { phase: 'shell-update-download', exe: GUI },
      config: { shellWatchdogPhaseMaxAgeMs: 2000 },
    });
    await m.w.tick();
    m.adv(3000);
    await m.w.tick();
    check('N-b 相位陈旧 → 不再延长宽限（按正常宽限介入）且 expectedAbsence=false',
      m.calls.restarts.length === 1 && m.w.status().expectedAbsence === false, 'restarts=' + m.calls.restarts.length);
  }

  {
    const m = mk({ alive: false, identity: { phase: 'ready', exe: GUI } });
    await m.w.tick(); m.adv(1200); await m.w.tick();
    check('N-c phase=ready → expectedAbsence=false', m.w.status().expectedAbsence === false, 'false');
  }

  {
    const m = mk({
      alive: false,
      identity: { phase: 'ready', exe: GUI },
      journal: { to: '9.9.9', confirmed: false },
    });
    await m.w.tick(); m.adv(1200); await m.w.tick();
    check('N-d 未确认账本 → expectedAbsence=true（语义保留）且不抢跑',
      m.w.status().expectedAbsence === true && m.calls.restarts.length === 0, 'restarts=' + m.calls.restarts.length);
  }

  {
    const m = mk({
      alive: false,
      identity: { phase: 'shell-update-download', exe: GUI },
      config: { shellWatchdogPhaseMaxAgeMs: 2000 },
    });
    await m.w.tick();
    m.adv(1500);
    m.setIdentity({ phase: 'ready', exe: GUI });
    await m.w.tick();
    m.setIdentity({ phase: 'shell-update-download', exe: GUI });
    m.adv(1500);
    const expected = m.w.status().expectedAbsence;
    check('N-e 离开相位后计时复位（重新进入重新计时）', expected === true, String(expected));
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();