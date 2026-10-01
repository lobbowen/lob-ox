#!/usr/bin/env node
'use strict';


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { safePort } = require(path.join(__dirname, '_ports'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-e2e-'));
process.env.DSH_SUPERVISOR_HOME = HOME;
const swDir = path.join(HOME, 'supervisor');
const shDir = path.join(HOME, 'shell');
fs.mkdirSync(swDir, { recursive: true });
fs.mkdirSync(shDir, { recursive: true });

// 假壳必须可被 spawn：POSIX 脚本在 Windows 无法执行，child_process.spawn 也不能直接 spawn .cmd/.bat（EINVAL）⇒ POSIX 用脚本、Windows 用 node.exe 拷贝（真实 PE）+ NODE_OPTIONS=--require <hook>。
const marker = path.join(HOME, 'launched.txt');
const isWin = process.platform === 'win32';
const fakeShell = path.join(HOME, isWin ? 'dsh-supervisor-gui.exe' : 'dsh-supervisor-gui');
if (isWin) {
  fs.copyFileSync(process.execPath, fakeShell);
  const hook = path.join(HOME, 'fake-shell-hook.js');
  fs.writeFileSync(hook, [
    "const fs = require('node:fs');",
    "fs.appendFileSync(" + JSON.stringify(marker) + ", 'launched ' + process.pid + String.fromCharCode(10));",
    "setTimeout(function () {}, 60000);",
    "",
  ].join(String.fromCharCode(10)));
  process.env.NODE_OPTIONS = '--require ' + hook;
} else {
  fs.writeFileSync(fakeShell,
    '#!/bin/sh' + String.fromCharCode(10) +
    'echo "launched $$" >> "' + marker + '"' + String.fromCharCode(10) +
    'sleep 20' + String.fromCharCode(10));
  fs.chmodSync(fakeShell, 0o755);
}

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
  shellProcPattern: 'dsh-supervisor-gui-watchdog-e2e-only',
  shellWatchdogIntervalMs: 1000,
  shellWatchdogGraceMs: 1500,
  shellWatchdogMaxRestarts: 2,
};

process.env.HOME = HOME;
// 必须同时设 USERPROFILE：只设 HOME 会让 shell.identity() 读不到夹具的 identity.json ⇒ hasExe=false ⇒ 不拉起。
process.env.USERPROFILE = HOME;

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  let sup = null;
  try {
    sup = new Supervisor(cfg);
    sup.start();

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

    const st = sup.shellWatchdog ? sup.shellWatchdog.status() : null;
    check('E2E-5 状态可观测（窗口内拉起次数）且图形会话判定可用',
      !!(st && st.restartsInWindow >= 1 && st.session && typeof st.session.available === 'boolean'),
      st ? ('restarts=' + st.restartsInWindow + ' session=' + st.session.reason) : 'null');
  } catch (e) {
    check('E2E 执行未抛异常', false, (e && e.stack) || String(e));
  } finally {
    try { if (sup) sup.shutdown(); } catch {}
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