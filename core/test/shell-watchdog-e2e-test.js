#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 桌面壳看护 —— **端到端**验证
//
// 与 shell-watchdog-test.js 的分工：后者是纯决策逻辑（注入 mock、离线）；本测试用**真实
//   Supervisor 进程 + 真实 spawn**，证明「壳缺失 -> 真的被拉起」这条链是通的。单元测试能证明
//   「决策正确」，不能证明「接进守卫后真的会拉起」—— 本项目已多次出现「逻辑对、接线断」。
//
// 隔离手段：沙箱 HOME（守卫的状态/identity/日志全在其中）· 假壳脚本写标记文件（拉起即证明）·
//   **唯一进程名**（本机可能真有壳在跑，用不存在的名字确保进入「缺失」分支）·
//   端口取自 test/_ports.js 安全段（避开 OS ephemeral 与生产池）。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { safePort } = require(path.join(__dirname, '_ports'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-e2e-'));
// 产品状态根隔离（独立于 DSH）：DSH_SUPERVISOR_HOME=HOME => <HOME>/{supervisor,shell}。
process.env.DSH_SUPERVISOR_HOME = HOME;
const swDir = path.join(HOME, 'supervisor');
const shDir = path.join(HOME, 'shell');
fs.mkdirSync(swDir, { recursive: true });
fs.mkdirSync(shDir, { recursive: true });

// 假壳：被拉起即写标记，然后挂住（避免立刻退出被当成又缺失）。
//   必须让假壳**可被 spawn**：① POSIX 脚本在 Windows 无法执行；② Node 的 child_process.spawn
//   **不能直接 spawn .cmd/.bat**（需 shell:true），而产品用 spawn(exe, [], {detached:true,
//   stdio:'ignore'}) -> 实测 CI 报 "spawn EINVAL"。最终方案：POSIX 用可执行 shell 脚本；
//   Windows 用**node.exe 的拷贝**（真实 PE）配 NODE_OPTIONS=--require <hook>（经 env 透传，已实测
//   有效）写标记并挂住。两者行为一致：把 "launched <pid>" 追加到标记文件并挂住约 20s。
const marker = path.join(HOME, 'launched.txt');
const isWin = process.platform === 'win32';
const fakeShell = path.join(HOME, isWin ? 'dsh-supervisor-gui.exe' : 'dsh-supervisor-gui');
if (isWin) {
  // 假壳 = node.exe 的拷贝（PE，可被 spawn）；行为由 --require 的 hook 定义。
  fs.copyFileSync(process.execPath, fakeShell);
  const hook = path.join(HOME, 'fake-shell-hook.js');
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    // 写真实 pid：清理逻辑据此 SIGKILL 回收（与 POSIX 分支同一格式）
    "fs.appendFileSync(" + JSON.stringify(marker) + ", 'launched ' + process.pid + String.fromCharCode(10));",
    "setTimeout(function () {}, 60000);",
    "",
  ].join(String.fromCharCode(10)));
  // NODE_OPTIONS 经 env 透传给被拉起的 node；--require 在允许列表内。
  process.env.NODE_OPTIONS = '--require ' + hook;
} else {
  fs.writeFileSync(fakeShell,
    '#!/bin/sh' + String.fromCharCode(10) +
    'echo "launched $$" >> "' + marker + '"' + String.fromCharCode(10) +
    'sleep 20' + String.fromCharCode(10));
  fs.chmodSync(fakeShell, 0o755);
}

// 壳的 identity.json：phase=ready（非预期缺席）+ 记录 exe（看护的路径来源）
fs.writeFileSync(path.join(shDir, 'identity.json'), JSON.stringify({
  version: '0.0.0-test', platform: process.platform, arch: process.arch,
  phase: 'ready', pid: 999999, exe: fakeShell,
  startedAt: Math.floor(Date.now() / 1000), attempt: 0, pinned: [],
}, null, 2));

const apiPort = safePort('shell-watchdog-e2e', 0);
const cfg = {
  apiHost: '127.0.0.1', apiPort,
  command: ['node', '-e', 'setInterval(()=>{},1000)'],
  healthUrl: 'http://127.0.0.1:' + safePort('shell-watchdog-e2e', 1) + '/',
  stateFile: path.join(swDir, 'state.json'),
  logFile: path.join(swDir, 'events.log'),
  supervisorLogFile: path.join(swDir, 'guard.log'),
  dshLogFile: path.join(swDir, 'dsh.log'),
  upgradeLogFile: path.join(swDir, 'upgrade.log'),
  probeIntervalMs: 1000,
  updateCheckEnabled: false, notifyEnabled: false,
  // 唯一进程名 -> 恒定「壳缺失」；短宽限 -> 验证快速
  shellProcPattern: 'dsh-supervisor-gui-watchdog-e2e-only',
  shellWatchdogIntervalMs: 1000,
  shellWatchdogGraceMs: 1500,
  shellWatchdogMaxRestarts: 2,
};

process.env.HOME = HOME;
//  **必须同时设 USERPROFILE**（本仓既有约定）：Node 的 os.homedir() 在 **Windows 上优先读
//  USERPROFILE**，而 shell.identity() 经 shellDir()（产品状态根 = DSH_SUPERVISOR_HOME）定位
//  identity.json —— 只设 HOME 时 Windows 读不到夹具写入的 identity.json -> hasExe=false ->
//  **不拉起** -> E2E-1/3/4/5 在 Windows 必红。这是夹具未遵循既有约定，不是产品问题。
process.env.USERPROFILE = HOME;

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  let sup = null;
  try {
    sup = new Supervisor(cfg);
    sup.start();

    // 观察窗：宽限 1.5s + 若干拍
    for (let i = 0; i < 14 && !fs.existsSync(marker); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    const launched = fs.existsSync(marker);
    check('E2E-1 壳缺失 → 被真实拉起（写入标记）', launched,
      launched ? fs.readFileSync(marker, 'utf8').trim() : '未见标记文件');

    const log = fs.existsSync(cfg.supervisorLogFile) ? fs.readFileSync(cfg.supervisorLogFile, 'utf8') : '';
    check('E2E-3 先计时再拉起（有宽限，不抢跑）',
      /开始计时/.test(log) && /已拉起 pid=/.test(log), 'ok');
    check('E2E-4 拉起使用的是 identity.json 记录的 exe',
      log.includes(fakeShell), 'exe=' + fakeShell);

    // E2E-5+E2E-6 合一（同一次 status() 返回形状的两处采样）。
    const st = sup.shellWatchdog ? sup.shellWatchdog.status() : null;
    check('E2E-5 状态可观测（窗口内拉起次数）且图形会话判定可用',
      !!(st && st.restartsInWindow >= 1 && st.session && typeof st.session.available === 'boolean'),
      st ? ('restarts=' + st.restartsInWindow + ' session=' + st.session.reason) : 'null');
  } catch (e) {
    check('E2E 执行未抛异常', false, (e && e.stack) || String(e));
  } finally {
    try { if (sup) sup.shutdown(); } catch {}
    //  清掉被拉起的假壳：restartShell 以 detached+unref 方式 spawn，
    //   不清会**遗留进程**（测试不应泄漏进程）。标记文件里记了它的 pid。
    try {
      if (fs.existsSync(marker)) {
        for (const line of fs.readFileSync(marker, 'utf8').split(/\r?\n/)) {
          const m = /launched (\d+)/.exec(line);
          if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch {} }
        }
      }
    } catch {}
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();