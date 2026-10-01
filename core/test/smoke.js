#!/usr/bin/env node
'use strict';

// 冒烟测试：按设计文档第 12 节的核心用例验证 dsh-supervisor（全部针对 mock 目标，不触碰真实 DSH）。
// 用法: node test/smoke.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-supervisor');
const MOCK = path.join(__dirname, 'mock-target.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sup-test-'));

// 测试卫生（RC6）：任意退出路径统一清理 mock/守护进程——防残留进程污染下一轮运行
process.on('exit', () => {
  try { const { execSync } = require('node:child_process');
    execSync("pkill -CONT -f 'mock-target.js' || true", { stdio: 'ignore' });
    execSync("pkill -9 -f 'mock-target.js' || true", { stdio: 'ignore' });
  } catch {}
});

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  ← ' + extra : ''));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 工具 ----
function makeConfig(apiPort, targetPort, overrides = {}) {
  return {
    command: ['node', MOCK, String(targetPort)],
    healthUrl: `http://127.0.0.1:${targetPort}/`,
    probeIntervalMs: 300,
    probeTimeoutMs: 1200,
    failThreshold: 2,
    startTimeoutMs: 5000,
    stopGraceMs: 800,
    killWaitMs: 1500,
    portReleaseWaitMs: 600,
    crashWindowMs: 10000,
    crashBurst: 4,
    backoff: [1500, 3000, 6000],
    apiHost: '127.0.0.1',
    apiPort,
    stateFile: path.join(TMP, `state-${apiPort}.json`),
    logFile: path.join(TMP, `events-${apiPort}.log`),
    supervisorLogFile: path.join(TMP, `supervisor-${apiPort}.log`),
    dshLogFile: path.join(TMP, `dsh-${apiPort}.log`),
    upgradeLogFile: path.join(TMP, `upgrade-${apiPort}.log`),
    ...overrides,
  };
}

function api(port, method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve({ error: 'parse', raw: body });
        }
      });
      res.on('error', () => resolve({ error: 'response error' }));
    });
    req.on('error', () => resolve({ error: 'conn' }));
    req.end();
  });
}

async function waitStatus(port, pred, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await api(port, 'GET', '/status');
    if (!s.error && pred(s)) return s;
    await sleep(200);
  }
  return null;
}

async function getEvents(port) {
  const r = await api(port, 'GET', '/events?limit=500');
  return (r && r.events) || [];
}

function startDaemon(cfg, env = {}) {
  const cfgPath = path.join(TMP, `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const child = spawn('node', [CLI, 'daemon', '-c', cfgPath], {
    env: { ...process.env, DSH_SUPERVISOR_CONFIG: cfgPath, DSH_SUPERVISOR_LOCK_FILE: path.join(TMP, 'guard-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.lock'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, cfgPath, out: () => out };
}

async function killDaemon(d) {
  if (!d.child.killed) d.child.kill('SIGTERM');
  await new Promise((r) => d.child.once('exit', r));
}

// ---- 场景 ----
async function main() {
  //: 守护跟着开关走(默认关,守护开才自动拉起)
  try {
    fs.writeFileSync(path.join(TMP, 'dsh-main.json'), JSON.stringify({ guardian: true }));
  } catch (e) {}
  console.log('== S1: 自动启动（desired=running → spawn → RUNNING）==');
  const d1 = startDaemon(makeConfig(3900, 3901));
  let s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid);
  check('daemon 自动拉起目标并进入 RUNNING', !!s, JSON.stringify(s));
  let ev = await getEvents(3900);

  console.log('== S2: 崩溃恢复（kill -9 → 自动重启）==');
  const pid1 = s.dshPid;
  try {
    process.kill(pid1, 'SIGKILL');
  } catch {}
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== pid1, 20000);
  check('SIGKILL 后自动重启到新 pid', !!s, JSON.stringify(s));

  console.log('== S3: 纯端口/进程判定——挂起进程端口仍在=健康，不误杀不重启 ==');
  const pid2 = s.dshPid;
  try {
    process.kill(pid2, 'SIGSTOP');
  } catch {}
  // 只做端口+pid 判定：进程被 SIGSTOP 挂起但端口仍监听、pid 仍存活 -> 视为健康，不重启。
  await sleep(1200);
  s = await api(3900, 'GET', '/status');
  ev = await getEvents(3900);
  // 「挂起 ≠ 不健康」的三个观察面：pid/phase 不变、无 http_unhealthy 重启、无 SIGKILL。
  check('S3 挂起进程视为健康：同一 pid 仍 RUNNING、未触发重启、未使用 SIGKILL',
    s && s.phase === 'RUNNING' && s.dshPid === pid2
    && !ev.some((e) => e.type === 'restart_triggered' && /http_unhealthy/.test((e.data && e.data.reason) || ''))
    && !ev.some((e) => e.type === 'sigkill_sent'),
    JSON.stringify(s) + ' ev=' + ev.map((e) => e.type).join(','));
  // 恢复进程，供后续场景使用
  try {
    process.kill(pid2, 'SIGCONT');
  } catch {}
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid === pid2, 5000);

  console.log('== S4: 主动停服不误拉（desired=stopped）==');
  const evPreStop = await getEvents(3900);
  const spawnBeforeStop = evPreStop.filter((e) => e.type === 'spawned').length;
  await api(3900, 'POST', '/lifecycle/dsh/stop');
  s = await waitStatus(3900, (x) => x.phase === 'STOPPED' && x.desired === 'stopped' && !x.dshPid);
  check('stop 后进入 STOPPED', !!s, JSON.stringify(s));
  await sleep(2000);
  s = await api(3900, 'GET', '/status');
  ev = await getEvents(3900);
  const spawnAfterStop = ev.filter((e) => e.type === 'spawned').length;
  check(
    'desired=stopped 期间不重新 spawn',
    s.phase === 'STOPPED' && spawnAfterStop === spawnBeforeStop,
    'phase=' + s.phase + ' spawns=' + spawnAfterStop + '/' + spawnBeforeStop
  );

  console.log('== S5: 重新启动（desired=running）==');
  await api(3900, 'POST', '/lifecycle/dsh/start');
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid);
  check('start 后恢复 RUNNING', !!s, JSON.stringify(s));

  console.log('== S6: 手动重启一次（不改变 desired、不计崩溃次数）==');
  const rcBefore = s.restartCount;
  const pid3 = s.dshPid;
  await api(3900, 'POST', '/lifecycle/dsh/restart');
  s = await waitStatus(3900, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== pid3, 20000);
  check('manual restart 执行', !!s, JSON.stringify(s));
  check('restartCount 未被手动重启计入', s.restartCount === rcBefore, `before=${rcBefore} after=${s.restartCount}`);
  await killDaemon(d1);
  // 场景卫生：守卫退出不动目标（守护语义）-> 显式清掉本场景最后的目标进程，
  //   防遗留 mock 在下一场景被 re-derive/adopt 误接管。
  if (s && s.dshPid) { try { process.kill(s.dshPid, 'SIGKILL'); } catch {} }

  console.log('== S7: 崩溃循环退避（启动即挂 ×N → BACKOFF）==');
  const d2 = startDaemon(
    makeConfig(3910, 3911, { startTimeoutMs: 700, crashWindowMs: 30000 }),
    { MOCK_EXIT_ON_START: '1' }
  );
  s = await waitStatus(3910, (x) => x.phase === 'BACKOFF', 28200);
  // BACKOFF 窗口短，phase 快照可能错过；以事件为准
  ev = await getEvents(3910);
  check('crash_loop_entered 事件存在', ev.some((e) => e.type === 'crash_loop_entered'));
  await sleep(2500); // 等退避到期重试并再次失败，验证退避升级
  s = await waitStatus(3910, (x) => x.backoffLevel >= 1, 15000);
  check('退避级别升级（backoffLevel >= 1）', !!s, JSON.stringify(s));
  await killDaemon(d2);

  console.log('== S8: 接管既有实例（adopt）＋ 无主实例恢复 ==');
  const external = spawn('node', [MOCK, '3921'], { stdio: 'ignore' });
  await sleep(600);
  const d3 = startDaemon(makeConfig(3920, 3921));
  s = await waitStatus(3920, (x) => x.phase === 'RUNNING' && x.adopted === true, 10000);
  check('接管既有健康实例（adopted）', !!s, JSON.stringify(s));
  external.kill('SIGKILL');
  s = await waitStatus(3920, (x) => x.phase === 'RUNNING' && x.dshPid, 20000);
  check('无主实例消亡后由守卫拉起自己的实例', !!s, JSON.stringify(s));
  await killDaemon(d3);

  console.log('== S9: 端口被不健康进程占用：不硬抢、只告警（§12 用例7）==');
  const occupier = http.createServer((req, res) => { res.writeHead(500); res.end('no'); });
  await new Promise((r) => occupier.listen(3961, '127.0.0.1', r));
  const d9 = startDaemon(makeConfig(3960, 3961));
  // 不用固定 sleep：判定耗时随 runner 负载波动，改为轮询等目标事件、超时再判定。
  ev = await getEvents(3960);
  {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !ev.some((e) => e.type === 'port_occupied_unhealthy')) {
      await sleep(250);
      ev = await getEvents(3960);
    }
  }
  s = await api(3960, 'GET', '/status');
  check(
    '端口被占时守卫不 spawn、只记 port_occupied_unhealthy，且保持 STOPPED 等待',
    ev.some((e) => e.type === 'port_occupied_unhealthy') && !ev.some((e) => e.type === 'spawned') && s.phase === 'STOPPED',
    JSON.stringify(ev.map((e) => e.type)) + ' phase=' + s.phase
  );
  await killDaemon(d9);
  occupier.close();

  console.log('== S10: 守卫崩溃重启幂等，不叠加实例（§12 用例5）==');
  const cfgX = makeConfig(3970, 3971);
  const dx1 = startDaemon(cfgX);
  s = await waitStatus(3970, (x) => x.phase === 'RUNNING' && x.dshPid, 15000);
  check('首个守卫拉起目标', !!s, JSON.stringify(s));
  const targetPid1 = s.dshPid;
  try { process.kill(dx1.child.pid, 'SIGKILL'); } catch {}
  await sleep(800);
  const dx2 = startDaemon(cfgX);
  s = await waitStatus(3970, (x) => x.phase === 'RUNNING' && x.adopted === true, 15000);
  check('新守卫接管既有实例而非二次 spawn', !!s, JSON.stringify(s));
  check('接管记录了目标 pid', s && s.dshPid === targetPid1, targetPid1 + ' -> ' + (s && s.dshPid));
  try { process.kill(targetPid1, 'SIGKILL'); } catch {}
  s = await waitStatus(3970, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== targetPid1, 25000);
  check('无主目标消亡后新守卫拉起自己的实例', !!s, JSON.stringify(s));
  await killDaemon(dx2);

  console.log('== S11: 接管实例可被 stop 停止 ==');
  const external11 = spawn('node', [MOCK, '3981'], { stdio: 'ignore' });
  const extExited = new Promise((r) => external11.once('exit', r));
  await sleep(600);
  const d11 = startDaemon(makeConfig(3980, 3981));
  s = await waitStatus(3980, (x) => x.phase === 'RUNNING' && x.adopted === true && x.dshPid, 10000);
  check('接管外部实例并识别 pid', !!s && s.dshPid === external11.pid, JSON.stringify(s));
  await api(3980, 'POST', '/lifecycle/dsh/stop');
  const extResult = await Promise.race([extExited, sleep(6000).then(() => 'timeout')]);
  check('stop 后外部实例进程退出', extResult !== 'timeout', String(extResult));
  s = await api(3980, 'GET', '/status');
  check('守卫收敛到 STOPPED 且不再拉起', s.phase === 'STOPPED' && s.desired === 'stopped', JSON.stringify(s));
  await killDaemon(d11);

  console.log('== S12: desired=stopped 时观测无主实例，不强杀；start 无缝转正 ==');
  const ext12 = spawn('node', [MOCK, '3991'], { stdio: 'ignore' });
  await sleep(600);
  const cfg12 = makeConfig(3990, 3991);
  fs.writeFileSync(cfg12.stateFile, JSON.stringify({ desired: 'stopped' })); // 预置期望停止
  const d12 = startDaemon(cfg12);
  s = await waitStatus(3990, (x) => x.phase === 'OBSERVED' && x.adopted === true && x.dshPid === ext12.pid, 10000);
  check('期望停止下进入 OBSERVED 并识别 pid', !!s, JSON.stringify(s));
  let extAlive = true;
  try { process.kill(ext12.pid, 0); } catch { extAlive = false; }
  check('观测模式不强杀运行中的实例', extAlive);
  await api(3990, 'POST', '/lifecycle/dsh/start');
  s = await waitStatus(3990, (x) => x.phase === 'RUNNING' && x.dshPid === ext12.pid && x.adopted === true, 10000);
  check('start 后同一实例无缝转正纳管', !!s, JSON.stringify(s));
  ev = await getEvents(3990);
  const spawns12 = ev.filter((e) => e.type === 'spawned').length;
  check('转正过程未重新 spawn', spawns12 === 0, 'spawns=' + spawns12);
  await killDaemon(d12);
  try { ext12.kill('SIGKILL'); } catch {}

  console.log('== S13: 启动链端到端（面板由这个端口发出 / 锁可归因 / 让位带原因 / 残留锁可回收）==');
  // S1-S12 只问 /status；这里按壳的读法走一遍真机坏掉的三环：ports.json 里的**实际**端口、
  //  守卫锁、面板文档本身（现场表现：进面板 = 127.0.0.1 拒绝连接）。
  const LOCK13 = path.join(TMP, 's13-guard.lock');
  const portsFile13 = path.join(TMP, 'ports.json'); // 与 stateFile 同目录（configureFile 规则）
  const apiRecs13 = () => {
    try {
      return (JSON.parse(fs.readFileSync(portsFile13, 'utf8')).records || []).filter((r) => r.role === 'supervisor-api');
    } catch { return []; }
  };
  const rawReq13 = (port, p) => new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: b }));
    });
    rq.on('error', () => resolve({ code: 0, headers: {}, body: '' }));
    rq.end();
  });
  // 锁阈值不从 CLI 源码正则读（源码文本耦合⇒判据失效或误红）：用与产品常量无关的有界等待。
  const LOCK_SILENCE_GIVEUP_MS = 60000, LOCK_TAKE_CAP_MS = 45000;
  /** 等到「新守卫按产品自己的判据能接管」为止，返回判定依据：POSIX 上强杀的守卫立刻 ESRCH，
   *  Windows 上刚终止的 pid 可能仍报活，此时唯一证据只剩续约沉默。 */
  async function waitReclaimable13(pid, cap = LOCK_SILENCE_GIVEUP_MS + 20000) {
    const end = Date.now() + cap;
    for (;;) {
      if (!fs.existsSync(LOCK13)) return '锁已释放';
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
      if (!alive) return '持有 pid ' + pid + ' 已退出';
      let silent = -1;
      try { silent = Date.now() - fs.statSync(LOCK13).mtimeMs; } catch {}
      if (silent >= LOCK_SILENCE_GIVEUP_MS) return '锁 ' + Math.round(silent / 1000) + 's 未续约';
      if (Date.now() >= end) return 'timeout：pid 仍报活且锁仍在续约（' + silent + 'ms）';
      await sleep(300);
    }
  }
  /** 按壳的读法取号：登记表里本次启动写下的 supervisor-api 记录唯一**且该端口真的在应答**
   *  ——只看唯一性会拿到前任留下、没人监听的旧端口，那正是「拒绝连接」的形态。 */
  async function servingPort13(sinceMs, ms = 20000) {
    const end = Date.now() + ms;
    for (;;) {
      const recs = apiRecs13().filter((r) => Number(r.createdAt) >= sinceMs);
      if (recs.length === 1) {
        const p = Number(recs[0].port);
        if (p > 0 && (await rawReq13(p, '/healthz')).code === 200) return p;
      }
      if (Date.now() > end) return -1;
      await sleep(250);
    }
  }
  const t13 = Date.now() - 1000;   // 减 1s：登记表用 Date.now()，同一毫秒内启动会把它自己的记录滤掉
  const d13 = startDaemon(makeConfig(3930, 3931), { DSH_SUPERVISOR_LOCK_FILE: LOCK13 });
  const p13 = await servingPort13(t13);
  check('S13 就绪判据成立：登记表里那个端口 /healthz 真的 2xx', p13 > 0,
    'cfgPort=3930 got=' + p13 + ' recs=' + JSON.stringify(apiRecs13()));
  const panel13 = await rawReq13(p13 > 0 ? p13 : 3930, '/');
  check('S13 面板文档真的由该端口发出（React 挂载点在 body 内）',
    panel13.code === 200 && /<div id="root">/.test(panel13.body),
    panel13.code === 503 ? 'UI 未构建：npm test 前须先跑 bash release/scripts/build-ui.sh'
      : 'code=' + panel13.code + ' len=' + panel13.body.length);
  const fa13 = (String(panel13.headers['content-security-policy'] || '').match(/frame-ancestors([^;]*)/) || [])[1] || '';
  const miss13 = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'].filter((o) => !fa13.includes(o));
  check('S13 面板能被桌面壳的内容 iframe 承载（壳 origin 逐个放行、非 none、无通配）',
    miss13.length === 0 && !/'none'/.test(fa13) && !/\*/.test(fa13),
    '缺失=' + miss13.join(' ') + ' 头=' + String(panel13.headers['content-security-policy'] || '(无 CSP 头)'));
  let lock13 = null;
  try { lock13 = JSON.parse(fs.readFileSync(LOCK13, 'utf8')); } catch {}
  check('S13 守卫锁可归因（pid=本守卫、entry 指向本产品 CLI）',
    !!lock13 && lock13.pid === d13.child.pid && /dsh-supervisor/.test(String(lock13.entry)), JSON.stringify(lock13));
  const d13b = startDaemon(makeConfig(3932, 3933), { DSH_SUPERVISOR_LOCK_FILE: LOCK13 });
  const code13b = await Promise.race([
    new Promise((r) => d13b.child.once('exit', (c) => r(c))),
    sleep(LOCK_TAKE_CAP_MS).then(() => 'timeout'),
  ]);
  check('S13 撞锁的第二实例退出非零（绝不双守卫并存）且点名持有者',
    code13b !== 'timeout' && code13b !== 0 && String(d13b.out()).includes('持有 pid ' + d13.child.pid),
    'exit=' + String(code13b) + ' out=' + d13b.out().trim().slice(-200));
  check('S13 让位者不得改写登记表（面板地址仍指向活着的守卫）',
    apiRecs13().length === 1 && Number(apiRecs13()[0].port) === p13, JSON.stringify(apiRecs13()));
  // SIGKILL：exit 钩子不跑 -> 正是 Windows「按命令行强杀」留下的残留锁形态。
  try { process.kill(d13.child.pid, 'SIGKILL'); } catch {}
  await new Promise((r) => d13.child.once('exit', r));
  const why13d = await waitReclaimable13(d13.child.pid);
  const t13d = Date.now() - 1000;
  const d13d = startDaemon(makeConfig(3930, 3931), { DSH_SUPERVISOR_LOCK_FILE: LOCK13 });
  check('S13 残留锁必须可回收（否则守卫永远起不来、面板永远拒绝连接）',
    (await servingPort13(t13d, LOCK_TAKE_CAP_MS)) > 0,
    '判据=' + why13d + ' out=' + d13d.out().trim().slice(-200));
  await killDaemon(d13d);

  // 清理残留 mock：先 SIGCONT（S3 里 SIGSTOP 过的挂起进程不响应 SIGTERM 会漏杀 ->
  //  残留 mock 占端口，下一轮 S1 会 adopt 而非 spawn 导致偶发 FAIL），再 SIGKILL。
  try {
    const { execSync } = require('node:child_process');
    execSync("pkill -CONT -f 'mock-target.js' || true", { stdio: 'ignore' });
    execSync("pkill -9 -f 'mock-target.js'", { stdio: 'ignore' });
  } catch {}

  console.log('\n==============================');
  console.log(`结果: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke test error:', e);
  process.exit(1);
});