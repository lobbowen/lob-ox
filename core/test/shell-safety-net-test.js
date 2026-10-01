#!/usr/bin/env node
'use strict';

// 桌面壳更新安全网回归：R1 账本/判定 · R2 健康确认 · R3 强制更新永不回退
//   · R6 状态目录隔离 · R7 API 归属 · R8 壳版本检测 · R9 壳重启（绝不误杀真进程）

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : '')); };
const LF = String.fromCharCode(10);


// 测试主体包进 async IIFE：本套测试自 含 await（checkUpdate/restartShell），
// 而 CommonJS 顶层不允许 await —— 之前全同步掩盖了这一点。
(async () => {

  // 隔离 HOME，避免污染真实壳状态。**必须同时设 USERPROFILE**：Node 的 os.homedir() 在 Windows 上优先读 USERPROFILE。
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-net-'));
  process.env.HOME = TMP;
  process.env.USERPROFILE = TMP;
  // 产品状态根隔离（独立于 DSH）：DSH_SUPERVISOR_HOME=TMP => <TMP>/{shell,supervisor}。
  process.env.DSH_SUPERVISOR_HOME = TMP;
  if (process.platform === 'win32') {
    // 双保险：os.homedir() 在 USERPROFILE 缺失时的回退来源
    process.env.HOMEDRIVE = '';
    process.env.HOMEPATH = '';
  }

  const shell = require(path.join(ROOT, 'src', 'domains', 'shell', 'index.js'));
  const writeIdentity = (o) => fs.writeFileSync(path.join(shell.shellDir(), 'identity.json'), JSON.stringify(o));

  // -- R6 隔离 --
  console.log('== R6 状态目录物理隔离 ==');
  // 判隔离性行为：壳状态目录须为状态根下独立一侧，与内核状态目录互不包含。
  const dir = shell.shellDir();
  fs.mkdirSync(dir, { recursive: true });
  {
    const kern = path.join(TMP, 'supervisor');
    check('R6-a 壳状态目录与内核状态目录物理隔离（互不包含）',
      dir !== kern && !(dir + path.sep).startsWith(kern + path.sep)
      && !(kern + path.sep).startsWith(dir + path.sep) && path.relative(TMP, dir) !== '',
      dir);
  }
  // -- R1 账本 --
  console.log('== R1 账本与初始判定 ==');
  check('R1-a 初始无更新 → idle', shell.evaluate().state === 'idle', shell.evaluate().state);
  const rec = shell.markPending('0.1.0', '0.2.0');
  check('R1-b markPending 写入 to', rec.to === '0.2.0' && rec.from === '0.1.0', JSON.stringify({ to: rec.to, from: rec.from }));

  // -- R2 健康确认 --
  console.log('== R2 健康确认 ==');
  writeIdentity({ version: '0.2.0', attempt: 0, phase: 'boot' });
  const h = shell.health({ phase: 'ready', version: '0.2.0' });
  check('R2-a ready + 版本匹配 → confirmed 且落账', h.state === 'confirmed' && shell.readJournal().confirmed === true, h.state);

  shell.markPending('0.2.0', '0.3.0');
  writeIdentity({ version: '0.2.0', attempt: 1, phase: 'boot' });
  const ev1 = shell.evaluate();
  writeIdentity({ version: '0.2.0', attempt: 99, phase: 'boot' });
  const ev = shell.evaluate();
  check('R3-a attempt=1 与 attempt=99 均为 pending（永不回退），且判定含当前/目标版本',
    ev1.state === 'pending' && ev.state === 'pending'
    && ev.current === '0.2.0' && ev.target === '0.3.0', ev.state + '/' + ev.reason);

  // -- API 域：路由归属 --
  console.log('== API 域归属 ==');
  {
    const apiShell = require(path.join(ROOT, 'src', 'api', 'domains', 'shell.js'));
    check('R7-a owns /shell/status 与 /shell/health，且不 own 其它路径',
      apiShell.owns('/shell/status') && apiShell.owns('/shell/health')
      && !apiShell.owns('/status') && !apiShell.owns('/instances'));
    const surface = require(path.join(ROOT, 'src', 'api', 'contract.js'));
    const paths = surface.SURFACE.filter((e) => e.domain === 'shell').map((e) => e.path).sort();
    check('R7-e 含壳版本检测端点', paths.includes('/shell/check-update'), JSON.stringify(paths));
    check('R7-f 含壳重启端点', paths.includes('/shell/restart'), JSON.stringify(paths));
  }

  // -- R8 壳版本检测（内核只查版本，不做安装）--
  console.log('== R8 壳版本检测 ==');
  {
    writeIdentity({ version: '1.0.1', attempt: 0, phase: 'ready' });
    const fakeDist = (latest) => ({ fetchLatestVersion: async () => latest });
    const up = await shell.checkUpdate(fakeDist('1.0.2'), {});
    check('R8-a 远端更高 → updateAvailable=true，且回报 installed/latest',
      up.ok === true && up.updateAvailable === true && up.installed === '1.0.1' && up.latest === '1.0.2', JSON.stringify(up));

    const same = await shell.checkUpdate(fakeDist('1.0.1'), {});
    const older = await shell.checkUpdate(fakeDist('1.0.0'), {});
    // R8-c+R8-d 合一：同一风险「不高于当前就不报可更新」的两个输入（相等 / 更低）。
    check('R8-c 相同或更低版本 → updateAvailable=false（不降级诱导）',
      same.ok === true && same.updateAvailable === false && older.updateAvailable === false, 'ok');

    const none = await shell.checkUpdate(fakeDist(null), {});
    check('R8-e 查不到版本 → ok=false 明确报错', none.ok === false && !!none.error, JSON.stringify(none));

    const noDist = await shell.checkUpdate(null, {});
    check('R8-f 分发服务缺失 → ok=false（不抛异常）', noDist.ok === false, JSON.stringify(noDist));

    const boom = await shell.checkUpdate({ fetchLatestVersion: async () => { throw new Error('network down'); } }, {});
    check('R8-g 查询抛错 → 捕获为 ok=false 并原样交出原因', boom.ok === false && !!boom.error, JSON.stringify(boom));
  }

  // -- R9 壳重启（安全：绝不误杀真实进程）--
  console.log('== R9 壳重启 ==');
  {
    // 用一个**不存在的**进程名，确保不会碰到开发者本机正在运行的壳。
    const r = await shell.restartShell({ procPattern: 'dsh-supervisor-gui-no-such-proc-xyz' });
    check('R9-a 无壳进程且无 exePath → ok=false 明确失败', r.ok === false && !!r.error, JSON.stringify(r));

    // 用不存在的进程名 + node 自身（win32 上 /bin/true 不存在），不碰真机进程。
    const r2 = await shell.restartShell({ procPattern: 'dsh-supervisor-gui-no-such-proc-xyz', exePath: process.execPath });
    check('R9-b 有 exePath → 尝试拉起并返回 ok，且未杀任何真实进程',
      r2.ok === true && r2.restarted === true
      && Array.isArray(r2.killed) && r2.killed.length === 0, JSON.stringify(r2));
  }

  const failed = results.filter((r) => !r);
  console.log(LF + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);

})().catch((e) => { console.error("ERR", e); process.exit(1); });
