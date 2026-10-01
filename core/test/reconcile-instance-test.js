#!/usr/bin/env node
'use strict';


const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

const mockApp = path.join(TMP, 'verproxy.js');
fs.writeFileSync(mockApp, "const http = require('node:http');\nconst argv = process.argv.slice(2);\nfunction arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }\nconst port = parseInt(arg('port','18999'),10);\nhttp.createServer((req,res)=>{ if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok', version:'1.2.3'})); return; } res.writeHead(404); res.end('nf'); }).listen(port,'127.0.0.1',()=>console.log('verproxy on '+port));\nprocess.on('SIGTERM',()=>process.exit(0));\n");

// 进程泄漏防线：登记本测试 spawn 的全部子进程 pid，退出前强制 SIGKILL —— stopInstance 的兜底是 unref 定时器，测试进程先退出即留孤儿占 4100x 端口。
const allProviders = [];
const spawnedPids = new Set();
function killSpawnedSync() {
  for (const pid of spawnedPids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  spawnedPids.clear();
  for (const p of allProviders) { for (const i of (p.instances || [])) { try { if (i.pid) process.kill(i.pid, 'SIGKILL'); } catch {} } }
}
process.on('exit', () => killSpawnedSync());
process.on('SIGINT', () => { killSpawnedSync(); process.exit(130); });
process.on('SIGTERM', () => { killSpawnedSync(); process.exit(143); });

(async () => {
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  const _origDoStart = ProxyProvider.prototype._doStart;
  ProxyProvider.prototype._doStart = async function (inst) {
    const r = await _origDoStart.call(this, inst);
    if (r && r.ok && inst && inst.pid) spawnedPids.add(inst.pid);
    return r;
  };
  const { keyFingerprint } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  const ports = require(path.join(ROOT, 'src', 'platform', 'service', 'ports')).shared;
  ports.configureFile(path.join(TMP, 'ports-router.json'));
  const log = { info(){}, warn(){}, error(){}, debug(){} };
  const app = { id: 'vm', name: 'VM', command: ['node', mockApp, '--port', '{{port}}', '--api-key', '{{key}}'], healthPath: '/health', upstream: 'http://127.0.0.1:0', real: false, quota: { type: 'commandcode-billing', apiBase: 'http://127.0.0.1:9' } };

  const addAcc = async (p, key, pct, status, extraQ, regAt) => {
    const inst = await p.ensureInstance(key);
    const quota = Object.assign({ weekly: { status: 'ok', percent: pct }, monthly: { status: 'ok', percent: pct }, monthlyRemaining: 10 }, extraQ || {});
    const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: status || 'ready', quota, registeredAt: regAt || Date.now() };
    p.accounts.push(acc);
    return acc;
  };

  const mkProv = (id, appOverride, activated) => {
    const p = new ProxyProvider({ id, name: id.toUpperCase(), kind: 'proxy', proxyAppId: 'vm', app: appOverride || app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = activated !== false;
    return p;
  };

  {
    const p = mkProv('p1');
    const A = await addAcc(p, 'sk-a1', 10, 'ready', null, 1000);
    const B = await addAcc(p, 'sk-a2', 20, 'ready', null, 2000);
    const C = await addAcc(p, 'sk-a3', 30, 'ready', null, 3000);
    const r = await p.reconcileInstances();
    check('R1a 期望集 = 登记序前 2（在用 A + 预热 B），C 在等待区',
      r.desired.length === 2 && r.desired[0] === A.keyId && r.desired[1] === B.keyId, JSON.stringify(r.desired));
    const running = (p.instances || []).filter((i) => i.pid);
    check('R1b 存活进程数 = |期望集| = 2（在用+预热各 1）', running.length === 2, 'running=' + running.length);
    const cInst = p.instanceOf(C);
    check('R1c 等待区账号零进程且端口归零（LC 核心-3）', !cInst.pid && !cInst.port && !ports.byOwner('proxy:' + C.keyId), 'pid=' + cInst.pid + ' port=' + cInst.port);
    check('R1d 期望集账号保留绑定端口（防漂移，冷账号可再拉起）',
      !!p.instanceOf(A).port && !!p.instanceOf(B).port, '');
    const r2 = await p.reconcileInstances();
    check('R1e 对账幂等（不重复 spawn）', r2.started.length === 0, JSON.stringify(r2.started));
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  {
    const p = mkProv('p2');
    const A = await addAcc(p, 'sk-b1', 10, 'ready', null, 1000);
    const B = await addAcc(p, 'sk-b2', 20, 'ready', null, 2000);
    const C = await addAcc(p, 'sk-b3', 30, 'ready', null, 3000);
    await p.reconcileInstances(); // 在用 A + 预热 B（sticky 记录进 _prewarmKeyId）
    p.selectedAccountKeyId = C.keyId;
    const r = await p.reconcileInstances();
    check('R2b selected 提为在用，预热 sticky 留任（期望集 = C,B 而非 C,A）',
      r.desired.length === 2 && r.desired.includes(C.keyId) && r.desired.includes(B.keyId) && !r.desired.includes(A.keyId), JSON.stringify(r.desired));
    const aInst = p.instanceOf(A);
    check('R2c 退位者进程被回收（停止仲裁，无在途即终止）', !aInst.pid, 'pid=' + aInst.pid);
    await p.reconcileInstances(); // 第二拍：零进程非期望记录端口归零
    check('R2d 退位者端口下一拍释放（等待区零存在）', !aInst.port && !ports.byOwner('proxy:' + A.keyId), 'port=' + aInst.port);
    const running = (p.instances || []).filter((i) => i.pid);
    check('R2e 存活进程 ≤ 2（在用1+预热1 资源最低）', running.length === 2, 'running=' + running.length);
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  {
    const p = mkProv('p3');
    const ok = await addAcc(p, 'sk-ok', 10, 'ready', null, 1000);
    const bad = await addAcc(p, 'sk-bad', 100, 'ready', { weekly: { status: 'rate-limited', percent: 100 } }, 2000); // ready 但满额
    const badInst = p.instanceOf(bad);
    await p.startInstance(badInst);
    await new Promise((res) => setTimeout(res, 800));
    const r = await p.reconcileInstances();
    check('R3b 对账后 bad（不可用）实例被回收', !badInst.pid, 'pid=' + badInst.pid);
    check('R3c ok（在用）实例在跑且期望集不含不可用账号',
      !!p.instanceOf(ok).pid && !r.desired.includes(bad.keyId), JSON.stringify(r.desired));
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  {
    const p = mkProv('p4');
    const resident = await addAcc(p, 'sk-r4', 85, 'ready', null, 1000);
    const spare = await addAcc(p, 'sk-s4', 10, 'ready', null, 2000);
    const full = await addAcc(p, 'sk-f4', 100, 'ready', { weekly: { status: 'rate-limited', percent: 100 } }, 3000);
    p.selectedAccountKeyId = resident.keyId;
    await p.reconcileInstances();
    const rInst = p.instanceOf(resident);
    p.markQuotaExhausted(resident, 3600000);
    check('R4a 冻结即同步回收：进程与端口零宽限归零（_onStatusTransition→reclaimAccount）',
      !rInst.pid && !rInst.port && !ports.byOwner('proxy:' + resident.keyId), 'pid=' + rInst.pid + ' port=' + rInst.port);
    await new Promise((res) => setTimeout(res, 1500)); // reconcileNow（恢复/收敛回池）异步收敛
    const runningKeys = (p.instances || []).filter((i) => i.pid).map((i) => i.keyId);
    check('R4b 冻结后 spare 晋升在用在跑（reconcileNow 由 mark* 触发）', runningKeys.includes(spare.keyId), JSON.stringify(runningKeys));
    check('R4c 满额账号（full）不被拉起', !runningKeys.includes(full.keyId), JSON.stringify(runningKeys));
    for (const i of p.instances) { if (i.pid) p.stopInstance(i); }
    await new Promise((res) => setTimeout(res, 400));
  }

  {
    const p = mkProv('p5', null, false);
    const a = await addAcc(p, 'sk-u', 10);
    check('R5a 无 activeAccount 且实例未跑 / 清 activeAccount 后 → idle', p.usageOf(a) === 'idle', p.usageOf(a));
    p.markInUse(a.keyId);
    check('R5b markInUse → in-use', p.usageOf(a) === 'in-use', p.usageOf(a));
    p.activeAccount = null;
    p.activated = true;
    const sr = await p.startInstance(p.instanceOf(a));
    await new Promise((res) => setTimeout(res, 600));
    check('R5e 实例在跑非在用 → warming', p.usageOf(a) === 'warming', p.usageOf(a) + ' pid=' + (p.instanceOf(a) && p.instanceOf(a).pid));
    p.markInUse(a.keyId);
    check('R5f 在用（activeAccount）→ in-use（实例运行态让位）', p.usageOf(a) === 'in-use', p.usageOf(a));
    if (p.instanceOf(a) && p.instanceOf(a).pid) p.stopInstance(p.instanceOf(a));
    await new Promise((res) => setTimeout(res, 400));
  }


  {
    const p = mkProv('p7');
    const key = 'sk-orph'; const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...orph', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    await p.startInstance(inst);
    acc.inflight = 1;
    p.discardAccount(acc.keyId); // 在途 discard -> stopInstance 延迟 + accounts 移除 -> orphan
    acc.inflight = 0;
    await p.reconcileInstances();
    await new Promise((res) => setTimeout(res, 400));
    check('R7b reconcile 回收孤儿实例（进程不泄漏）', !inst.pid, 'pid=' + inst.pid);
    try { if (inst.pid) { p.stopInstance(inst); } } catch { try { process.kill(inst.pid, 'SIGKILL'); } catch {} }
    await new Promise((res) => setTimeout(res, 400));
  }

  {
    const p = mkProv('p8');
    const key = 'sk-infl'; const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...infl', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    await p.startInstance(inst);
    acc.inflight = 1;
    p.stopInstance(inst); // 在途 -> 待停标记（不杀）
    check('R8a 在途时 stop 仅标记（进程保留）', inst.pid && acc._stopPendingUntilIdle === true, 'pid=' + inst.pid + ' pending=' + acc._stopPendingUntilIdle);
    acc.inflight = 0;
    p._retryPendingStop(acc); // 模拟 forward-core 在途归零调用
    await new Promise((res) => setTimeout(res, 300));
    check('R8b 在途归零补刀立即停（不泄漏）', !inst.pid, 'pid=' + inst.pid);
    try { if (inst.pid) p.stopInstance(inst); } catch { try { process.kill(inst.pid, 'SIGKILL'); } catch {} }
    await new Promise((res) => setTimeout(res, 300));
  }

  {
    const p = mkProv('p9');
    const addA = async (key, pct, at) => { const inst = await p.ensureInstance(key); const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: 'ready', quota: { weekly: { status: 'ok', percent: pct }, monthly: { status: 'ok', percent: pct }, monthlyRemaining: 10 }, registeredAt: at }; p.accounts.push(acc); return acc; };
    const a1 = await addA('sk-alt1', 10, 1000);
    const a2 = await addA('sk-alt2', 12, 2000);
    let starts = 0, stops = 0;
    const osi = p.startInstance.bind(p); const ost = p.stopInstance.bind(p);
    p.startInstance = function (i) { starts++; return osi(i); };
    p.stopInstance = function (i) { stops++; return ost(i); };
    for (let rr = 0; rr < 10; rr++) {
      const a = (rr % 2 === 0) ? a1 : a2;
      await p.ensureServable(a);
      p.markInUse(a.keyId);
      if (rr % 2 === 1) { await p.reconcileInstances(); }
    }
    check('R9a 10 次交替请求启停有界（≤3 次 spawn）', starts <= 3, 'starts=' + starts + ' stops=' + stops);
    for (const i of p.instances) if (i.pid) p.stopInstance(i);
    await new Promise((res) => setTimeout(res, 400));
  }

  {
    const p = mkProv('p10');
    const key = 'sk-single'; const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...single', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    let startedTotal = 0;
    const osi = p.startInstance.bind(p);
    p.startInstance = function (i) { startedTotal++; return osi(i); };
    const rA = p.reconcileInstances();
    const rB = p.reconcileInstances();
    const rC = p.reconcileInstances();
    await Promise.all([rA, rB, rC]);
    check('R10a 并发 reconcile 不重复 spawn（单飞）', startedTotal === 1, 'spawn=' + startedTotal);
    check('R10b 单飞后实例在跑', inst.pid ? true : false, '');
    for (const i of p.instances) if (i.pid) p.stopInstance(i);
    await new Promise((res) => setTimeout(res, 400));
  }

  {
    const app2 = Object.assign({}, app, { pkg: 'verproxy' }); // 带 cmdline 可匹配标记（幸存判定前提）
    const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const waitListener = async (port, expectPid, timeoutMs) => {
      const dl = Date.now() + (timeoutMs || 5000);
      while (Date.now() < dl) {
        const lp = pidlook.findListeningPid(port);
        if (expectPid === undefined ? lp : lp === expectPid) return lp;
        await new Promise((res) => setTimeout(res, 120));
      }
      return pidlook.findListeningPid(port);
    };
    const mkP = (id) => mkProv(id, app2);
    const mkAcc = async (pr, key, pct) => { const inst = await pr.ensureInstance(key); const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: 'ready', quota: { weekly: { status: 'ok', percent: pct }, monthly: { status: 'ok', percent: pct }, monthlyRemaining: 10 }, registeredAt: Date.now() }; pr.accounts.push(acc); return inst; };
    const assertReclaimed = async (label, pr, inst, port, survivorPid) => {
      const r = await pr.startInstance(inst);
      const newPid = inst.pid;
      check('R11-' + label + '-1 弃用重拉（新 pid，非幸存者）', r.ok === true && !!newPid && newPid !== survivorPid, 'new=' + newPid + ' survivor=' + survivorPid + ' r=' + JSON.stringify(r).slice(0, 140));
      const got = await waitListener(port, newPid);
      check('R11-' + label + '-2 绑定端口监听者=新实例（同端口不漂移）', got === newPid, 'got=' + got);
      check('R11-' + label + '-4 幸存者已清（无幽灵进程）', !pidlook.isAlive(survivorPid), 'survivor alive=' + pidlook.isAlive(survivorPid));
      if (inst.pid) pr.stopInstance(inst);
      await new Promise((res) => setTimeout(res, 500));
    };
    {
      const p1 = mkP('p11a-1');
      const inst1 = await mkAcc(p1, 'sk-surv-h', 10);
      await p1.startInstance(inst1);
      const survivorPid = inst1.pid;
      const boundPort = inst1.port;
      await waitListener(boundPort, survivorPid);
      const p2 = mkP('p11a-2');
      const inst2 = await mkAcc(p2, 'sk-surv-h', 10);
      inst2.port = boundPort; // 模拟重启：绑定端口恢复 + pid 空
      await assertReclaimed('a', p2, inst2, boundPort, survivorPid);
    }
    {
      const p = mkP('p11b');
      const key = 'sk-surv-s';
      const inst = await mkAcc(p, key, 10);
      const slot = await ports.claimSlot('proxyInstance', 'proxy:' + inst.keyId, {});
      const boundPort = slot.port;
      inst.port = boundPort;
      const sickApp = path.join(TMP, 'verproxy-sick.js'); // 文件名含 pkg 标记 -> cmdline 命中幸存判定
      fs.writeFileSync(sickApp, "const http = require('node:http');\nconst argv = process.argv.slice(2);\nfunction arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }\nconst port = parseInt(arg('port','18997'),10);\nhttp.createServer((req,res)=>{ res.writeHead(500); res.end('sick'); }).listen(port,'127.0.0.1',()=>console.log('sick on '+port));\nprocess.on('SIGTERM',()=>process.exit(0));\n");
      const { spawn } = require('node:child_process');
      const sickProc = spawn(process.execPath, [sickApp, '--port', String(boundPort)], { stdio: 'ignore' });
      spawnedPids.add(sickProc.pid);
      await waitListener(boundPort, sickProc.pid);
      await assertReclaimed('b', p, inst, boundPort, sickProc.pid);
    }
  }

  {
    const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const p = mkProv('p12');
    const stubApp = path.join(TMP, 'verproxy-stubborn.js'); // 忽略 SIGTERM（只吃 SIGKILL），模拟停服退不干净的进程
    fs.writeFileSync(stubApp, "const http = require('node:http');\nconst argv = process.argv.slice(2);\nfunction arg(name, def){ const i=argv.indexOf('--'+name); return i>=0 && argv[i+1] ? argv[i+1] : def; }\nconst port = parseInt(arg('port','18996'),10);\nhttp.createServer((req,res)=>{ if (req.url === '/health') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({status:'ok'})); return; } res.writeHead(404); res.end('nf'); }).listen(port,'127.0.0.1',()=>console.log('stubborn on '+port));\nprocess.on('SIGTERM', () => {});\nprocess.on('SIGINT', () => {});\n");
    p.app = Object.assign({}, app, { pkg: 'verproxy', command: ['node', stubApp, '--port', '{{port}}', '--api-key', '{{key}}'] });
    const key = 'sk-stub';
    const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...stub', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    await p.startInstance(inst);
    const pid = inst.pid;
    await new Promise((res) => setTimeout(res, 600));
    p.stopInstance(inst);
    // Windows 的 carrier 终止经 killTree 落为 taskkill /T /F 且是异步 spawn ⇒ 升级 SIGKILL 预算前给 1200ms 有界等待。
    const winNoSig = process.platform === 'win32';
    if (winNoSig) {
      const deadline = Date.now() + 1200;
      while (pidlook.isAlive(pid) && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 50));
      }
    }
    check('R12c stopInstance 后进程处理（POSIX：仍在=TERM 被忽略；Windows：taskkill 强杀在升级预算内杀净=无 SIGTERM 语义可抗）',
      winNoSig ? !pidlook.isAlive(pid) : pidlook.isAlive(pid), 'alive=' + pidlook.isAlive(pid));
    // zombie 判据必须走平台原语（Linux 读 /proc、macOS 看 ps 的 state 列、win32 无此形态）：只读 /proc 会让 macOS 上「SIGKILL 已投递、仅待回收」被判成活孤儿。
    const deadOrZombie = (one) => !pidlook.isAlive(one) || pidlook.isZombie(one);
    const why = (one) => 'alive=' + pidlook.isAlive(one) + ' zombie=' + pidlook.isZombie(one);
    const okW = await p.waitAllStopped(3000); // unref SIGKILL(1.5s) 或本方法超时兜底
    check('R12e waitAllStopped 后进程已死或已投递 SIGKILL（不留活孤儿）', okW === true && deadOrZombie(pid), why(pid));
    check('R12g 端口已释放（无孤儿占端口）', !pidlook.findListeningPid(inst.port), 'listener=' + pidlook.findListeningPid(inst.port));
    const key2 = 'sk-stub2';
    const inst2 = await p.ensureInstance(key2);
    const acc2 = { key: key2, keyId: inst2.keyId, maskedKey: '...stub2', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc2);
    p.selectedAccountKeyId = inst2.keyId; // 在用/选中 -> _canStopInstance false
    await p.startInstance(inst2);
    const pid2 = inst2.pid;
    await new Promise((res) => setTimeout(res, 600));
    p.stopInstance(inst2); // 无 force -> 在用 defer（进程保留）
    check('R12i 在用实例普通 stop 仅 defer（进程保留）', pidlook.isAlive(pid2), 'alive=' + pidlook.isAlive(pid2));
    p.stopInstance(inst2, true); // force（停服路径）-> 立即 TERM+SIGKILL 台账
    const dlj = Date.now() + 6000;
    while (Date.now() < dlj && !deadOrZombie(pid2)) { await new Promise((res) => setTimeout(res, 150)); }
    await p.waitAllStopped(5000); // 清台账（含 zombie：SIGKILL 已投递、端口/stdio 已释放）
    check('R12j force 停服：在用实例被强制终止（不留活孤儿）', deadOrZombie(pid2), why(pid2));
    await new Promise((res) => setTimeout(res, 300));
  }

  {
    const pidlook = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
    const p = mkProv('p13', Object.assign({}, app, { pkg: 'verproxy' }));
    const key = 'sk-rt13';
    const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...rt13', status: 'ready', quota: { weekly: { status: 'ok', percent: 5 }, monthly: { status: 'ok', percent: 5 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    await p.startInstance(inst);
    const pid1 = inst.pid;
    const port = inst.port;
    await new Promise((res) => setTimeout(res, 500));
    p.restartInstance(inst, 'upstream-timeout'); // forward-core 超时处置同款调用
    const dl = Date.now() + 6000;
    let pid2 = null;
    while (Date.now() < dl) {
      if (inst.pid && inst.pid !== pid1 && pidlook.isAlive(inst.pid) && pidlook.findListeningPid(port) === inst.pid) { pid2 = inst.pid; break; }
      await new Promise((res) => setTimeout(res, 150));
    }
    check('R13b 超时重启：新 pid 且旧进程已死', !!pid2 && !pidlook.isAlive(pid1), 'pid1=' + pid1 + ' pid2=' + pid2 + ' alive1=' + pidlook.isAlive(pid1));
    check('R13c 同端口监听（不漂移）', pidlook.findListeningPid(port) === pid2, 'listener=' + pidlook.findListeningPid(port));
    await new Promise((res) => setTimeout(res, 400));
    check('R13d 重启后实例健康', await fetch('http://127.0.0.1:' + port + '/health').then((x) => x.ok).catch(() => false), '');
    if (inst.pid) p.stopInstance(inst);
    await new Promise((res) => setTimeout(res, 500));
  }

  {
    const p = mkProv('p14');
    const key = 'sk-lk';
    const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...lk', status: 'ready', quota: { weekly: { status: 'ok', percent: 10 }, monthly: { status: 'ok', percent: 10 }, monthlyRemaining: 10 }, registeredAt: Date.now() };
    p.accounts.push(acc);
    acc.status = 'ready';
    p.selectedAccountKeyId = acc.keyId;
    acc.status = 'frozen'; // 绕过状态机构造「锁+冻结」矛盾态
    const ser = p.serialize();
    check('R14c serialize 收敛：冻结账号锁不落盘', ser.selectedAccountKeyId === null && p.selectedAccountKeyId === null, 'ser=' + String(ser.selectedAccountKeyId));
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });