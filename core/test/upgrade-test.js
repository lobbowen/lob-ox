#!/usr/bin/env node
'use strict';


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-supervisor');
const MOCK = path.join(__dirname, 'mock-target.js');
const FAKE = path.join(__dirname, 'fake-npm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upg-test-'));

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


function startRegistry(port, version) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function api(port, method, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 8000 }, (res) => {
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

async function waitStatus(port, pred, timeoutMs = 28220) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await api(port, 'GET', '/status');
    if (!s.error && pred(s)) return s;
    await sleep(400);
  }
  return null;
}

async function waitUpgrade(port, pred, timeoutMs = 28221) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await api(port, 'GET', '/native/status');
    const u = (s && s.upgrade) || {};
    if (!s.error && pred(u)) return u;
    await sleep(500);
  }
  return null;
}

function makePkgJson(version) {
  const p = path.join(TMP, `pkg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2));
  return p;
}

function makeConfig(apiPort, targetPort, regPort, pkgJson, overrides = {}) {
  return {
    command: ['node', MOCK, String(targetPort)],
    healthUrl: `http://127.0.0.1:${targetPort}/`,
    probeIntervalMs: 300,
    probeTimeoutMs: 1000,
    failThreshold: 2,
    startTimeoutMs: 5000,
    stopGraceMs: 600,
    killWaitMs: 1500,
    portReleaseWaitMs: 600,
    crashWindowMs: 600000,
    crashBurst: 5,
    backoff: [1500, 3000],
    apiHost: '127.0.0.1',
    apiPort,
    stateFile: path.join(TMP, `state-${apiPort}.json`),
    logFile: path.join(TMP, `events-${apiPort}.log`),
    supervisorLogFile: path.join(TMP, `supervisor-${apiPort}.log`),
    dshLogFile: path.join(TMP, `dsh-${apiPort}.log`),
    upgradeLogFile: path.join(TMP, `upgrade-${apiPort}.log`),
    packageName: '@deepseek-ai/dsh',
    registries: [`http://127.0.0.1:${regPort}`],
    updateCheckIntervalMs: 3600000,
    initialCheckDelayMs: 20000,
    upgradeTimeoutMs: 30000,
    installedPkgJsonPath: pkgJson,
    installCommandTemplate: ['node', FAKE, '{version}'],
    ...overrides,
  };
}

function startDaemon(cfg, env = {}) {
  const cfgPath = path.join(TMP, `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
process.on('exit', () => {
  try { const { execSync } = require('node:child_process');
    execSync("pkill -CONT -f 'mock-target.js' || true", { stdio: 'ignore' });
    execSync("pkill -9 -f 'mock-target.js' || true", { stdio: 'ignore' });
  } catch {}
});

  try { fs.writeFileSync(path.join(path.dirname(cfg.stateFile), 'dsh-main.json'), JSON.stringify({ guardian: true })); } catch {}

  const child = spawn('node', [CLI, 'daemon', '-c', cfgPath], {
    env: { ...process.env, DSH_SUPERVISOR_CONFIG: cfgPath, DSH_SUPERVISOR_LOCK_FILE: path.join(TMP, 'guard-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.lock'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, out: () => out };
}

async function killDaemon(d) {
  if (!d.child.killed) d.child.kill('SIGTERM');
  await new Promise((r) => d.child.once('exit', r));
}

async function main() {
  console.log('== U1: 版本检查（mock registry）==');
  await startRegistry(3950, '2.0.0');
  const pkgA = makePkgJson('1.0.0');
  const cfgA = makeConfig(3940, 3941, 3950, pkgA);
  const dA = startDaemon(cfgA, { FAKE_PKG_JSON: pkgA });
  let v = null;
  {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      v = (await api(3940, 'GET', '/native/status')).versionInfo || {};
      if (!v.error && v.latest === '2.0.0') break;
      await api(3940, 'POST', '/native/check-update');
      await sleep(500);
    }
  }
  check('U1 版本检查：installed=1.0.0 / latest=2.0.0 / updateAvailable=true',
    v && v.installed === '1.0.0' && v.latest === '2.0.0' && !!v.updateAvailable, JSON.stringify(v));

  console.log('== U2: 一键升级全链路 ==');
  await waitStatus(3940, (x) => x.phase === 'RUNNING' && x.dshPid, 15000);
  const before = await api(3940, 'GET', '/status');
  await api(3940, 'POST', '/native/upgrade');
  const st = await waitUpgrade(3940, (x) => x.state === 'done' || x.state === 'failed');
  if (st && st.state !== 'done') console.log('  [U2-diag] lastError=' + st.lastError + ' rolledBack=' + st.rolledBack + ' logTail=' + JSON.stringify((st.logTail || []).slice(-12)));
  check('升级终态=done', st && st.state === 'done', JSON.stringify(st && st.state));
  const pkgAfter = JSON.parse(fs.readFileSync(pkgA, 'utf8'));
  check('package.json 版本已切换到 2.0.0', pkgAfter.version === '2.0.0', pkgAfter.version);
  const after = await waitStatus(3940, (x) => x.phase === 'RUNNING' && x.dshPid);
  check('升级后 DSH 恢复 RUNNING 且进程已被替换（新版本生效）',
    !!(after && before.dshPid !== null && after.dshPid !== before.dshPid),
    `${before.dshPid} -> ${after && after.dshPid}`);
  check('计划内重启不计入崩溃窗口', after && after.restartCount === (before.restartCount || 0), `restartCount=${after && after.restartCount}`);

  console.log('== U3: 已是最新时跳过 ==');
  await api(3940, 'POST', '/native/upgrade');
  const st3 = await waitUpgrade(3940, (x) => x.state === 'done' || x.state === 'failed', 15000);
  if (st3 && st3.state !== 'done') console.log('  [U3-diag] lastError=' + st3.lastError + ' logTail=' + JSON.stringify((st3.logTail || []).slice(-12)));
  const pkg3 = JSON.parse(fs.readFileSync(pkgA, 'utf8'));
  check('已是最新 → 跳过（终态 done）且版本保持 2.0.0',
    !!st3 && st3.state === 'done' && pkg3.version === '2.0.0', JSON.stringify(st3 && st3.state) + ' ' + pkg3.version);

  console.log('== U4: 安装失败 → 报错且不影响运行中的 DSH ==');
  await startRegistry(3951, '3.0.0');
  const pkgB = makePkgJson('1.0.0');
  const cfgB = makeConfig(3942, 3943, 3951, pkgB);
  const dB = startDaemon(cfgB, { FAKE_MODE: 'fail', FAKE_PKG_JSON: pkgB });
  await waitStatus(3942, (x) => x.phase === 'RUNNING' && x.dshPid);
  const pidBefore = (await api(3942, 'GET', '/status')).dshPid;
  await api(3942, 'POST', '/native/upgrade');
  const st4 = await waitUpgrade(3942, (x) => x.state === 'failed' || x.state === 'done', 30000);
  check('失败终态=failed', st4 && st4.state === 'failed', JSON.stringify(st4 && st4.state));
  const pkgBAfter = JSON.parse(fs.readFileSync(pkgB, 'utf8'));
  check('失败后 package.json 未被破坏', pkgBAfter.version === '1.0.0', pkgBAfter.version);
  const s4 = await waitStatus(3942, (x) => x.phase === 'RUNNING' && x.dshPid && x.dshPid !== pidBefore, 20000);
  check('失败后 DSH 以旧版本恢复运行（新进程）', !!s4, pidBefore + ' -> ' + (s4 && s4.dshPid));
  await killDaemon(dB);

  await killDaemon(dA);

  console.log('== U5: 升级作业不得挡住自身的重启（非升级调用必须幂等短路）==');
  {
    const { InstanceManager } = require(path.join(ROOT, 'src', 'domains', 'instance', 'index'));
    const sandbox = require(path.join(ROOT, 'src', 'domains', 'instance', 'sandbox'));
    const { safePort } = require(path.join(__dirname, '_ports'));
    const logger = { info() {}, warn() {}, error() {}, debug() {} };

    const id = 'u1';
    const tasksStub = { isBusy: () => true, current: () => ({ action: 'upgrade' }) };
    // _prepareSystemd/_systemdStart 是组装根的闭包委托，实例上的补丁拦不住内部调用（会真跑 systemctl --user daemon-reload 与 mkdir）⇒ 必须构造期注入假平台服务。
    const systemdDir = path.join(TMP, 'systemd');
    const started = [];
    const fakeService = {
      daemonReload() { return true; },
      stopUnit() { return true; },
      resetFailed() { return true; },
      isUnitActive() { return false; },
      transientUnitFile() { return null; },
      cleanTransient() {},
      startTransient(o) { started.push(o); return true; },
    };
    const mgr = new InstanceManager({
      dir: TMP, logger, tasks: tasksStub, dist: null,
      service: fakeService, systemdDir,
    });
    mgr.systemdDir = systemdDir;
    mgr.systemdTemplatePath = path.join(systemdDir, 'dsh-web@.service');
    mgr._setSandboxSupportedForTest(true);       // 绕过平台能力门（显式测试入口）
    const inst = {
      id, name: '升级用例', domain: 'sandbox', port: safePort('instance-upgrade', 0),
      sandbox: { privateTmp: true, protectHome: false },
      state: { phase: 'STOPPED' },
    };
    mgr.instances = [inst];
    // 入口路径经 sandbox.dshEntry 推导：npm -g --prefix 的 node_modules 落点分平台，硬编码 POSIX 形在 Windows runner 必失配。
    const entry = sandbox.dshEntry(mgr.instancesRoot, inst);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// stub');

    const a = await mgr.startInstance(id);
    check('U5 非升级调用：作业忙 → 幂等短路（installing）且未拉起',
      a.installing === true && started.length === 0, JSON.stringify(a) + ' started=' + started.length);
  }

  console.log('== U6: 健康验证稳定期预算（慢启动不得被误判 → 避免不必要回滚）==');
  {
    const net = require('node:net');
    const { DistributionManager } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index'));
    const logger = { info() {}, warn() {}, error() {}, debug() {} };
    const dist = new DistributionManager({ logger });
    const freePort = () => new Promise((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const port = await freePort();
    const srv = net.createServer((s) => { s.on('error', () => {}); try { s.end('ok'); } catch {} });
    srv.on('error', () => {}); // 兜底：即使监听失败也不炸掉测试进程
    setTimeout(() => { try { srv.listen(port, '127.0.0.1'); } catch {} }, 3000);
    const r = await dist.waitPortHealthy({ host: '127.0.0.1', port, timeoutMs: 8000, stabilityMs: 15000 });
    check('U6 端口晚于 (timeout-stability) 就绪 → 仍判成功（慢启动不误判）', r.ok === true, JSON.stringify(r));
    try { srv.close(); } catch {} ; await sleep(50);

    const dead = await freePort();
    const r2 = await dist.waitPortHealthy({ host: '127.0.0.1', port: dead, timeoutMs: 2500, stabilityMs: 15000 });
    check('U6 反向：端口始终不就绪 → 判失败（不误报成功）', r2.ok === false, JSON.stringify(r2));
  }

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
  console.error('upgrade test error:', e);
  process.exit(1);
});
