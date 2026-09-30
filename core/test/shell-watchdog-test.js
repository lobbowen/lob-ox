#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 桌面壳看护（domains/shell/watchdog.js）回归测试
//
// 背景：修复前 Linux/macOS **完全没有**壳自愈；Windows 的 watchdog 把壳检查嵌在
//   `if (-not $up)` 内，「壳崩、守卫活」时整块跳过 —— 而那恰是唯一需要它的场景。
// 本测试锁定新机制的四条边界：只在真缺失时动作 / 宽限 / 需图形会话 / 有界重试。
//
// 全部离线：不碰真实进程、不碰真实文件系统、不绑端口（注入 mock 与时钟）。
// ---------------------------------------------------------------------------

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
// 纯决策/谓词已下沉 core.js（域结构改造）；看护状态机仍在 watchdog.js。
//    读取面必须随文件搬移同步更新，否则判据静默失去覆盖面（本仓已多次踩坑）。
const { createShellWatchdog } = require(path.join(ROOT, 'src', 'domains', 'shell', 'watchdog'));
const { decide, isShellProcess, HEADLESS_FLAGS } =
  require(path.join(ROOT, 'src', 'domains', 'shell', 'core'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// -- W1 decide() 纯函数穷举 --
console.log('== W1 decide() 决策穷举 ==');
{
  const cfg = { graceMs: 1000, updateGraceMs: 5000, maxRestarts: 3 };
  const base = { alive: 0, absentForMs: null, expectedAbsence: false, sessionAvailable: true, restartsInWindow: 0, hasExe: true, config: cfg };
  const d = (o) => decide(Object.assign({}, base, o));

  check('W1-a 壳在运行 → alive（不动作）', d({ alive: 2 }).action === 'alive');
  check('W1-b 首次发现缺失 → record（开始计时）', d({ absentForMs: null }).action === 'record');
  check('W1-c 未达宽限 → wait', d({ absentForMs: 500 }).action === 'wait');
  check('W1-d 达宽限 + 就绪 → restart', d({ absentForMs: 1000 }).action === 'restart');
  check('W1-e 预期缺席用 updateGraceMs（1s 不触发、超 5s 才重启）',
    d({ absentForMs: 1000, expectedAbsence: true }).action === 'wait'
    && d({ absentForMs: 5000, expectedAbsence: true }).action === 'restart');
  check('W1-g 无图形会话 → skip（拉起必失败）', d({ absentForMs: 9999, sessionAvailable: false }).action === 'skip');
  check('W1-h 达上限 → skip（防风暴）', d({ absentForMs: 9999, restartsInWindow: 3 }).action === 'skip');
  check('W1-i 无法定位 exe → skip（不盲拉）', d({ absentForMs: 9999, hasExe: false }).action === 'skip');
  // 优先级判据不判文案：无会话那条 skip 必须与「同时超上限」时给出**同一个 reason**。
  check('W1-j 决策优先级：无会话优先于上限',
    d({ absentForMs: 9999, sessionAvailable: false, restartsInWindow: 9 }).reason
      === d({ absentForMs: 9999, sessionAvailable: false }).reason);
}

// -- W2 进程过滤 --
console.log('== W2 isShellProcess 过滤 ==');
{
  check('W2-a 匹配壳主程序（POSIX 路径与 Windows .exe 同一判据）',
    isShellProcess({ cmdline: '/usr/bin/dsh-supervisor-gui' }) === true
    && isShellProcess({ cmdline: 'C:\\x\\dsh-supervisor-gui.exe' }) === true);
  check('W2-e 空 cmdline 不误判', isShellProcess({ cmdline: '' }) === false);
  // 无头模式清单必须与壳侧 main.rs「在 Tauri 初始化之前 exit」的分支一一对应：
  // 漏一项 = 那个瞬时进程被当成「壳在运行」，看护短路成 alive，真壳永不回来。
  // 枚举驱动覆盖全表，不再逐个具名重采样（避免「加一项就红」的名单锁）。
  check('W2-i 清单成员逐个被 isShellProcess 排除（枚举驱动，非计数）',
    Array.isArray(HEADLESS_FLAGS) && HEADLESS_FLAGS.length > 0
      && HEADLESS_FLAGS.every((f) => isShellProcess({ cmdline: 'dsh-supervisor-gui ' + f }) === false));
  // 反空转：判 false 的必须是「排除表命中」，不是「名字没匹配上壳」。
  check('W2-j 反向：未登记的同名进程仍判为壳',
    isShellProcess({ cmdline: 'dsh-supervisor-gui --some-future-headless-flag' }) === true);
}

// -- W3 tick() 集成（注入 mock）--
console.log('== W3 tick() 集成 ==');
const mk = (opts) => {
  const o = opts || {};
  let t = 1000000;
  const calls = { restarts: [] };
  const deps = {
    shell: {
      identity: () => (o.identity === undefined ? { exe: '/usr/bin/dsh-supervisor-gui', phase: o.phase || 'ready' } : o.identity),
      readJournal: () => (o.journal || { to: null, confirmed: false }),
      restartShell: async (a) => { calls.restarts.push(a); return o.restartResult || { ok: true, pid: 4321, exe: a.exePath }; },
    },
    pidlookup: { pgrepList: () => (o.alive ? [{ pid: 999, cmdline: '/usr/bin/dsh-supervisor-gui' }] : []) },
    desktop: { sessionAvailable: () => o.session !== false, describe: () => ({ available: o.session !== false, reason: 'test' }) },
    logger: { info() {}, warn() {} },
    events: { append() {} },
    config: Object.assign({ shellWatchdogGraceMs: 1000, shellWatchdogUpdateGraceMs: 5000 }, o.config || {}),
    now: () => t,
  };
  if (o.halted) deps.halted = o.halted;
  if (o.onShellAlive) deps.onShellAlive = o.onShellAlive;
  const w = createShellWatchdog(deps);
  return { w, calls, adv: (ms) => { t += ms; } };
};

(async () => {
  {
    const m = mk({ alive: true });
    const r = await m.w.tick();
    check('W3-a 壳存活 → 不拉起', m.calls.restarts.length === 0 && (r.alive === 1 || r.skipped === undefined), JSON.stringify(r));
  }
  {
    const m = mk({ alive: false });
    await m.w.tick();                                   // 首拍：record
    m.adv(1200);
    const r = await m.w.tick();                          // 超宽限：restart
    check('W3-b 缺失超宽限 → 拉起且用的是 identity.json 的 exe（非猜测）',
      m.calls.restarts.length === 1 && r.restarted === true
      && m.calls.restarts[0] && m.calls.restarts[0].exePath === '/usr/bin/dsh-supervisor-gui',
      JSON.stringify(m.calls.restarts[0]));
  }
  {
    const m = mk({ alive: false, session: false });
    await m.w.tick();
    m.adv(5000);
    await m.w.tick();
    check('W3-d 无图形会话 → 不拉起', m.calls.restarts.length === 0, 'restarts=' + m.calls.restarts.length);
  }
  {
    const m = mk({ alive: false, identity: { phase: 'shell-update-download', exe: '/x/gui' } });
    await m.w.tick();
    m.adv(1200);
    await m.w.tick();
    check('W3-e 壳处于更新中 → 不抢跑（宽限延长）', m.calls.restarts.length === 0, 'restarts=' + m.calls.restarts.length);
  }
  {
    const m = mk({ alive: false, identity: { phase: 'ready', exe: null } });
    await m.w.tick();
    m.adv(5000);
    const r = await m.w.tick();
    check('W3-f 无 exe 可定位 → 明确跳过而非盲拉', m.calls.restarts.length === 0 && !!r.skipped, JSON.stringify(r));
  }
  {
    const m = mk({ alive: false, config: { shellWatchdogMaxRestarts: 2 } });
    for (let i = 0; i < 6; i++) { await m.w.tick(); m.adv(2000); }
    check('W3-g 有界重试：不超过 maxRestarts', m.calls.restarts.length <= 2, 'restarts=' + m.calls.restarts.length);
  }
  {
    const m = mk({ alive: false, restartResult: { ok: false, error: 'spawn 失败' } });
    await m.w.tick();
    m.adv(1200);
    const r = await m.w.tick();
    check('W3-h 拉起失败 → 如实返回错误（不假成功）', r.restarted === false && !!r.error, JSON.stringify(r));
  }
  {
    //退出门下沉看护域 —— 退出中/已退出恒不拉起（退出管家后不再自愈）。
    const m = mk({ alive: false, halted: () => true });
    await m.w.tick();
    m.adv(5000);
    const r = await m.w.tick();
    check('W3-j 退出中/已退出 → 恒不拉起（skipped=halted）',
      m.calls.restarts.length === 0 && r.skipped === 'halted', JSON.stringify(r));
  }
  {
    // 壳在线 -> 回调清除持久退出标记（用户重开壳后自愈恢复，不会被永久抑制）。
    let seen = 0;
    const m = mk({ alive: true, onShellAlive: () => { seen++; } });
    await m.w.tick();
    check('W3-k 观测到壳在线 → 回调 onShellAlive（清除退出标记）', seen === 1, 'seen=' + seen);
  }

  // -- W4 能力声明（P-5 shellSelfHeal 一档的唯一所有者）--
  console.log('== W4 能力声明 ==');
  {
    const { capabilityProfile } = require(path.join(ROOT, 'src', 'platform', 'os'));
    const P = (pl, arch) => capabilityProfile(pl, arch || 'x64');
    // darwin 原生自启（独立 LaunchAgent）与「崩溃自愈」是两个独立字段，此处断言二者**同时**成立。
    check('W4 三平台 shellSelfHeal=true、未知平台 false；darwin 原生自启与崩溃自愈**同时**成立',
      P('linux').shellSelfHeal === true && P('darwin').shellSelfHeal === true
      && P('win32').shellSelfHeal === true && P('freebsd').shellSelfHeal === false
      && P('darwin', 'arm64').shellAutostart === true,
      ['linux', 'darwin', 'win32', 'freebsd'].map((p) => p + '=' + P(p).shellSelfHeal).join(','));
  }

  // -- W5 已移除跨仓读（identity.exe/lastSeenAt 的写入是壳仓自身契约）--
  //   内核侧只验消费行为：W1-i 无 exe 不盲拉、W3-b 用 identity.exe 拉起、W3-f exe 空则跳过。

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();