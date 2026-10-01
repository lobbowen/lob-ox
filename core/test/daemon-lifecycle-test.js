#!/usr/bin/env node
'use strict';

// 统一受管进程生命周期核心（src/infra/proc/daemon-lifecycle.js）回归：
//   ensureRunning 身份接管/首启 spawn/latch barrier · replace 换代（停旧->等死->等端口释放->才启新，
//   同一 ctl 端口绝不双代并存）· superviseOnce 死透才重拉 · stop。自包含：真 spawn fixture，不碰真实 daemon。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-lc-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { DaemonLifecycle } = require(path.join(ROOT, 'src', 'app', 'daemons', 'process'));
const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-ctl-daemon.js');
const CTL = 28040; // 测试专用端口段（远离生产）
const ctlHealth = () => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port: CTL, path: '/' }, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
  req.on('error', () => resolve(null));
  req.setTimeout(1200, () => { req.destroy(); resolve(null); });
});
const waitCtl = async (ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const h = await ctlHealth(); if (h && h.code === 200) return true; await sleep(150); } return false; };

(async () => {
  const identity = path.join(TMP, 'fake.identity.json');
  const marker = path.join(TMP, 'fake.marker');
  const mk = (opts) => new DaemonLifecycle(Object.assign({
    name: 'fake', script: FAKE, args: ['--port', String(CTL), '--marker', marker],
    ctlPort: CTL, cmdMark: 'fake-ctl-daemon', identityFile: identity,
    logger: { info() {}, warn() {}, error() {} }, events: null,
  }, opts || {}));

  console.log('== 首启 + 身份 ==');
  let dl = mk();
  let r1 = dl.ensureRunning();
  check('首启 → mode=started + pid 写入身份', r1.mode === 'started' && !!r1.pid && dl.expectedPid() === r1.pid, JSON.stringify(r1));
  await waitCtl(); // 夹具就绪等待
  await sleep(300);
  const pid1 = dl.expectedPid();

  console.log('== 幂等/接管：同身份再 ensure → adopted（不双拉）==');
  const dl2 = mk();
  const r2 = dl2.ensureRunning();
  check('再 ensure → adopted 同 pid', r2.mode === 'adopted' && r2.pid === pid1, JSON.stringify(r2));
  const h2 = await ctlHealth();
  check('ctl 仍同一 pid（单实例）', h2 && JSON.parse(h2.body).pid === pid1, h2 && h2.body);

  console.log('== 换代：kill 期望 pid → 新生命周期实例 replace（停残留→等死→等端口→启新同端口）==');
  try { process.kill(pid1, 'SIGKILL'); } catch {}
  await sleep(1500); // 等进程消失、端口释放
  const dlNew = mk(); // 全新实例（无历史 latch，模拟守卫重启后接管/换代）
  let replaced = null;
  for (let i = 0; i < 40; i++) {
    replaced = dlNew.ensureRunning();
    if (replaced.mode === 'started' || replaced.mode === 'adopted') break;
    if (replaced.mode === 'reclaiming') { await sleep(400); continue; } // 残留 TERM 后等释放再重试
    await sleep(200);
  }
  check('kill 后换代成功（新 pid ≠ 旧 pid，同 ctl 端口）', replaced && (replaced.mode === 'started' || replaced.mode === 'adopted') && replaced.pid !== pid1, JSON.stringify(replaced));
  const pid2 = dlNew.expectedPid();
  check('换代后 ctl 就绪且为新 pid', (await waitCtl()) && JSON.parse((await ctlHealth()).body).pid === pid2, String(pid2));
  dl = dlNew; // 后续沿用新实例

  console.log('== 换代期间 latch：进程刚死但 spawn 窗口内 → ensure → barrier（无双代）==');
  const dlB = mk();
  dlB.ensureRunning();
  await waitCtl();
  const pidB = dlB.expectedPid();
  try { process.kill(pidB, 'SIGKILL'); } catch {}
  await sleep(500);
  dlB._spawnWindowUntil = Date.now() + 20000; // 模拟刚 spawn（latch 有效）
  const r3 = dlB.ensureRunning();
  check('latch 窗口内 → mode=barrier（不双拉）', r3.mode === 'barrier', JSON.stringify(r3));
  dlB._spawnWindowUntil = 0;
  try { await dlB.stop(); } catch {}

  console.log('== stop：TERM → 等死 → 等端口释放 → 清身份 ==');
  const st = await dl.stop();
  check('stop ok + 身份已清', st.ok === true && dl.expectedPid() === null, JSON.stringify(st));
  await sleep(300);
  const h3 = await ctlHealth();
  check('端口已释放（ctl 无应答）', h3 === null, JSON.stringify(h3));

  console.log('== 孤儿回收（reclaimOrphans）：同 cmdline 的额外实例被 TERM，受管实例不受影响 ==');
  {
    const dlX = mk();
    dlX.ensureRunning();
    await waitCtl();
    const mainPid = dlX.expectedPid();
    // 再手工起一个同 cmdline 的“孤儿” fake（不同端口，模拟旧代/不可见命名空间残留）
    const { spawn } = require('node:child_process');
    const orphan = spawn(process.execPath, [FAKE, '--port', String(CTL + 100), '--marker', path.join(TMP, 'orphan.marker')], { stdio: 'ignore' });
    await sleep(800);
    const killed = dlX.reclaimOrphans();
    await sleep(600);
    const orphanDead = (() => { try { process.kill(orphan.pid, 0); return false; } catch { return true; } })();
    check('孤儿（同 cmdline、非受管）被 reclaimOrphans TERM', killed >= 1 && orphanDead, JSON.stringify({ killed, orphanPid: orphan.pid }));
    check('受管实例不受影响（同一 pid、ctl 正常）',
      dlX.expectedPid() === mainPid && (await ctlHealth()) && JSON.parse((await ctlHealth()).body).pid === mainPid, String(mainPid));
    try { await dlX.stop(); } catch {}
  }

  console.log('== 残留回收：伪造身份=已死 pid + 同 cmdMark 进程占 ctl → superviseOnce 先 TERM 再启 ==');
  // 手工起一个占 ctl 的 fake（不写身份）
  const child = require('node:child_process').spawn(process.execPath, [FAKE, '--port', String(CTL), '--marker', path.join(TMP, 'x.marker')], { stdio: 'ignore' });
  await waitCtl();
  const dl3 = mk();
  dl3._writeIdentity(999999); // 期望 pid 已死
  const sv = await dl3.superviseOnce();
  check('期望死 + ctl 被残留占 → reclaiming（先 TERM 残留）', sv.mode === 'reclaiming', JSON.stringify(sv));
  // 等残留死透 + 端口释放 -> 下轮 spawn
  let started = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    started = dl3.ensureRunning();
    if (started.mode === 'started') break;
  }
  check('残留清后 → 启新并 ctl 就绪', started && started.mode === 'started' && (await waitCtl()), JSON.stringify(started));
  try { await dl3.stop(); } catch {}
  if (child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });

// -- D-12：管理锁 = 原子取锁（'wx'）+ 持有者存活检测 + 只删自己的锁 --
{
  const idMod = require(path.join(ROOT, 'src', 'app', 'daemons', 'identity.js'));
  const { acquireLock, releaseLock, lockPid, pidAlive } = idMod._lockPrimitives;
  const dir = path.join(TMP, 'd12');
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'router-daemon.lock');
  const writeRaw = (txt) => fs.writeFileSync(lock, txt);

  check('D-12 全新取锁成功且内容为 pid',
    acquireLock(lock) === true && lockPid(lock) === process.pid, 'pid=' + lockPid(lock));
  check('D-12 二次取锁：持有者是自己 -> 仍成功（幂等，不误报易主）',
    acquireLock(lock) === true, 'ok');
  releaseLock(lock);
  check('D-12 释放后锁文件消失', !fs.existsSync(lock), 'gone');

  // 他主且存活：绝不能抢
  writeRaw(String(process.ppid || 1));
  const ppid = lockPid(lock); // 前提
  check('D-12 他主存活 -> 取锁失败且不覆盖内容',
    acquireLock(lock) === false && lockPid(lock) === ppid, 'holder=' + lockPid(lock));
  check('D-12 释放他人锁 -> no-op（只删自己的）',
    (releaseLock(lock), fs.existsSync(lock) && lockPid(lock) === ppid), 'kept=' + lockPid(lock));
  fs.rmSync(lock, { force: true });

  // 真-死 pid：起一个即刻退出的子进程，用它的 pid 模拟崩溃残留
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['-e', '']);
  const dead = r && r.pid; // 前提
  writeRaw(String(dead));
  const deadRecovered = acquireLock(lock) === true && lockPid(lock) === process.pid;
  releaseLock(lock);

  // 内容不可解析（旧格式/半写）与「持有者已死」同属残留自愈机制。
  fs.rmSync(lock, { force: true });
  writeRaw('not-a-pid');
  check('D-12 残留自愈：持有者已死 / 锁内容不可解析 -> 均清锁重试成功并改成本 pid',
    deadRecovered && lockPid(lock) === null && acquireLock(lock) === true && lockPid(lock) === process.pid, 'ok');
  releaseLock(lock);

  // 反向：父目录存在而锁不存在时 'wx' 首次创建必成功；真正的失败路径是「父目录都不存在」——
  //   ENOENT != EEXIST，取锁必须判 false 且不留任何半成品。
  check('D-12 反向：路径为 null -> 安全返回 false（不触碰 fs）',
    acquireLock(null) === false, 'null 路径安全');
  const ghostDir = path.join(TMP, 'd12-no-such-dir');
  const ghost = path.join(ghostDir, 'router-daemon.lock');
  fs.rmSync(ghostDir, { recursive: true, force: true });
  const ghostAcquire = acquireLock(ghost);
  releaseLock(ghost);
  check('D-12 反向：父目录缺失 -> 取锁判 false；失败路径不留半成品（不建锁文件/不补目录），释放亦 no-op',
    ghostAcquire === false && !fs.existsSync(ghost) && !fs.existsSync(ghostDir), 'false/absent');
}

// -- 判活三态（alive/dead/unknown）—— 探测异常不得被折叠成任何一侧 --
//   非 EPERM 的 kill 异常当死会误删他主锁/误认领死 pid；三态源 probeAlive 与布尔门面 isAlive 分离。
{
  const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
  check('非正整数 pid 一律 dead（不触碰 kill）',
    pidlook.probeAlive(0) === 'dead' && pidlook.probeAlive(-1) === 'dead' &&
    pidlook.probeAlive(NaN) === 'dead' && pidlook.probeAlive(1.5) === 'dead', 'dead');
  const realKill = process.kill;
  try {
    process.kill = () => { const e = new Error('ep'); e.code = 'EPERM'; throw e; };
    check('EPERM → alive（存在但无权，不得判死）', pidlook.probeAlive(4321) === 'alive', 'alive');
    process.kill = () => { const e = new Error('es'); e.code = 'ESRCH'; throw e; };
    check('ESRCH → dead', pidlook.probeAlive(4321) === 'dead', 'dead');
    process.kill = () => { const e = new Error('ei'); e.code = 'EINVAL'; throw e; };
    check('其它错误码 → unknown（既不判活也不判死）', pidlook.probeAlive(4321) === 'unknown', 'unknown');
    // _pidAlive 的 unknown 分支必须回落到所有权判定（只有登记过的主人才算活）。
    const { DaemonLifecycle } = require(path.join(ROOT, 'src', 'app', 'daemons', 'process'));
    const probeHost = Object.create(DaemonLifecycle.prototype);
    probeHost._ctlOwnerPid = () => 4321;
    check('_pidAlive: unknown + 是登记主人 → true；非主人 → false',
      probeHost._pidAlive(4321) === true && probeHost._pidAlive(9999) === false, 'owner-fallback');
    process.kill = () => { const e = new Error('es'); e.code = 'ESRCH'; throw e; };
    check('_pidAlive: ESRCH 时即便是登记主人也判死；无 pid 入参直接 false',
      probeHost._pidAlive(4321) === false && probeHost._pidAlive(null) === false, 'dead/no-pid');
  } finally { process.kill = realKill; }
  check('反向：真实 kill 已恢复 —— isAlive 布尔门面与 probeAlive 三态同源判活',
    pidlook.isAlive(process.pid) === true && pidlook.probeAlive(process.pid) === 'alive', 'alive');
}

// -- M8：守护计数链路 —— 崩溃收敛（countCrash:true）发 restart_triggered 且 restartCount +1；
//   计划内重启（manual）发事件但不计数（最小 cfg，不 start 定时器）。
{
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const { registerAll } = require(path.join(ROOT, 'src', 'app', 'control', 'adapters'));
  const m8Tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-lc-m8-'));
  const sup = new Supervisor({
    command: ['node', '-e', '0'],
    healthUrl: 'http://127.0.0.1:1/',
    probeIntervalMs: 100000, // 不触发 tick 副作用（本段只调重启记账，不 start 定时器）
    apiHost: '127.0.0.1', apiPort: 31991,
    stateFile: path.join(m8Tmp, 'state.json'),
    logFile: path.join(m8Tmp, 'events.log'),
    supervisorLogFile: path.join(m8Tmp, 'sup.log'),
    dshLogFile: path.join(m8Tmp, 'dsh.log'),
    upgradeLogFile: path.join(m8Tmp, 'up.log'),
    distDir: path.join(m8Tmp, 'dist'),
    switcherDir: path.join(m8Tmp, 'sw'),
    providerFile: path.join(m8Tmp, 'sw', 'providers.json'),
    lanDaemon: false, useSystemdForMain: false,
  });
  registerAll(sup.lifecycleManager, {
    router: sup.router, lan: sup.lan, instances: sup.instances,
    supervisor: sup, pluginManager: sup.pluginManager, logger: sup.logger,
  });
  const evs = [];
  const origAppend = sup.events.append.bind(sup.events);
  sup.events.append = (type, data) => { if (type === 'restart_triggered') evs.push(data); return origAppend(type, data); };
  const rcBefore = sup.restartCount;
  sup._beginRestart('exit:1', { countCrash: true }); sup._beginRestart('manual', { countCrash: false });
  sup.events.append = origAppend;
  check('M8 dsh 崩溃收敛发 restart_triggered 且 restartCount +1；计划内重启（manual）发事件但不计数',
    evs.length === 2 && evs[0].reason === 'exit:1' && evs[1].reason === 'manual' && sup.restartCount === rcBefore + 1,
    JSON.stringify({ evs, before: rcBefore, after: sup.restartCount }));
}

