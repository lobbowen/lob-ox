#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 壳看护：**陈旧 phase 的时效上限**
//
// 缺陷：`expectedAbsence()` 只要 identity.phase 是 restarting/shell-update-* 就恒真，宽限期永远走
// updateGraceMs（5min）而非 graceMs（90s）；而 phase 只由壳写入、唯一复位点是壳成功启动时的
// init_identity —— 壳更新中途崩溃且再也起不来时 phase 永久停在 shell-update-*，自愈被拖慢 3 倍
// 以上且无任何陈旧信号。
// 修法：看护自己计时——tick() 每拍 updatePhaseTracking，进入「更新中」相位开始计时，超过
// phaseMaxAgeMs（默认 10 分钟）仍在该相位即判陈旧，不再延长宽限；离开该相位即复位。
//   （不用 identity 文件 mtime/lastSeenAt：本模块是依赖注入+纯决策，identity() 在测试里是桩；
//     且壳的 set_phase() 只写 phase、不写 lastSeenAt，依赖该字段等于不生效。）
//
// 锁定不变量：N-a 新鲜「更新中」相位不抢跑；N-b 同相位超窗判陈旧、按正常宽限介入；
//   N-c phase=ready → 不视为预期缺席；N-d 有未确认账本 → 仍不抢跑；N-e 离开相位后计时复位。
// ---------------------------------------------------------------------------

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { createShellWatchdog } = require(path.join(ROOT, 'src', 'domains', 'shell', 'watchdog.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 注入时钟 + 注入 identity（与 shell-watchdog-test.js 的 mk 同构；不碰真实文件系统）
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
    pidlookup: { pgrepList: () => (o.alive ? [{ pid: 999, cmdline: '/usr/bin/dsh-supervisor-gui' }] : []) },
    desktop: { sessionAvailable: () => true, describe: () => ({ available: true, reason: 'test' }) },
    logger: { info() {}, warn() {} },
    events: { append() {} },
    config: Object.assign({ shellWatchdogGraceMs: 1000, shellWatchdogUpdateGraceMs: 5000 }, o.config || {}),
    now: () => t,
  };
  const w = createShellWatchdog(deps);
  return { w, calls, adv: (ms) => { t += ms; }, setIdentity: (v) => { identity = v; } };
};

const GUI = '/usr/bin/dsh-supervisor-gui';

(async () => {
  // -- N-a：新鲜「更新中」相位 -> 不抢跑 --
  {
    const m = mk({ alive: false, identity: { phase: 'shell-update-download', exe: GUI } });
    await m.w.tick();          // 首拍：record（开始计时 + 相位计时）
    m.adv(1200);               // 超 graceMs(1000) 但未到 updateGraceMs(5000)
    await m.w.tick();
    check('N-a 新鲜更新相位 → 不拉起（宽限延长）且 expectedAbsence=true',
      m.calls.restarts.length === 0 && m.w.status().expectedAbsence === true, 'restarts=' + m.calls.restarts.length);
  }

  // -- N-b：同一相位持续超过窗口 -> 判定陈旧 -> 按正常宽限介入 --
  {
    const m = mk({
      alive: false,
      identity: { phase: 'shell-update-download', exe: GUI },
      config: { shellWatchdogPhaseMaxAgeMs: 2000 }, // 2s 窗口（便于测试）
    });
    await m.w.tick();          // t=1000000：进入相位，expectedSince=1000000
    m.adv(3000);               // 3s > 2s 窗口 -> 陈旧
    await m.w.tick();
    check('N-b 相位陈旧 → 不再延长宽限（按正常宽限介入）且 expectedAbsence=false',
      m.calls.restarts.length === 1 && m.w.status().expectedAbsence === false, 'restarts=' + m.calls.restarts.length);
  }

  // -- N-c：phase=ready --
  {
    const m = mk({ alive: false, identity: { phase: 'ready', exe: GUI } });
    await m.w.tick(); m.adv(1200); await m.w.tick();
    check('N-c phase=ready → expectedAbsence=false', m.w.status().expectedAbsence === false, 'false');
  }

  // -- N-d：未确认账本 -> 仍 true（既有语义不回退）--
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

  // -- N-e：离开相位 -> 计时复位 --
  {
    const m = mk({
      alive: false,
      identity: { phase: 'shell-update-download', exe: GUI },
      config: { shellWatchdogPhaseMaxAgeMs: 2000 },
    });
    await m.w.tick();                 // 进入相位
    m.adv(1500);
    m.setIdentity({ phase: 'ready', exe: GUI });
    await m.w.tick();                 // 离开相位 -> 复位计时
    m.setIdentity({ phase: 'shell-update-download', exe: GUI });
    m.adv(1500);                      // 重新进入后仅 1.5s < 2s -> 仍新鲜
    const expected = m.w.status().expectedAbsence;
    check('N-e 离开相位后计时复位（重新进入重新计时）', expected === true, String(expected));
  }

  //  窗口可配置由 N-b 本身证明（它注入 shellWatchdogPhaseMaxAgeMs: 2000 并观察到 3s 后陈旧），
  //  故不再重放「大窗口/小窗口」两条 —— 那是 N-a/N-b 的同义重复；
  //  `DEFAULTS.phaseMaxAgeMs === 600000` 是**默认值策略锁定**（有人有理由调到 15 分钟时无故障却判红），
  //  一并删除。
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();