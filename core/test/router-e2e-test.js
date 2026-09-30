#!/usr/bin/env node
'use strict';

// 智能路由端到端测试（路由域收敛宿主；吸收原 p2p-router-test.js + p2p-api-test.js）。
//   前段：RouterService 直连/反代链路（真 listen mock 上游 + 真 spawn dry-run）——
//         预设注入 → 真探测入池 → 激活独立端点 → 转发/用量记账 → 反代实例真启停 →
//         持久化 round-trip → 重启后对账拉起（_ensureProxyInstances 的公开行为面）。
//   后段：完整 Supervisor + api.js 的 /router/* —— 只留有独立风险的四组：供应商端点生命周期、
//         keys/set 如实回报（假成功回归）、删除即释放端口登记、local() 应急视图 _stale 标注。
// 沙箱注意：bwrap --unshare-pid 下进程组 kill(-pid) 会误杀主进程，故 stopInstance 的真实 kill 链路由宿主验证；
//           本文件以真启停（start/stop）+ 真 pid/port/探活验证等价语义。所有网络目标均为本机 mock。
//
// 合并去留登记（原 p2p-router-test.js / p2p-api-test.js 的取舍，防静默丢覆盖）：
//   留下：直连/反代真链路 A/B/C + API 层四组 D（P9a-e→D1-D5、P17/P17b→D6、P29b/P30→D8/D11、P29→D10、P21→D9）。
//   删且判据他处承接：A3（per5hUsd 常量锁）、B9/B9b（四态词表 / 类型锁）、B11（→reconcile-instance-test）、
//     E（解冻→本文件 A5）、F（锁收敛→reconcile-instance-test R14c / router-test / switch-policies-test）、
//     维护私有字段段（形态锁）、key/use（→api-contract-test）、discard 正常路径（→A7）。
//   删且此后无独立覆盖（薄参数校验 / 端点存活性采样，单独保留无鉴别力）：/router/providers/refresh 的实现
//     就是 detectAccount+applyDetection 循环（src/domains/router/ops/quotasync.js:23-36），已由 A4/A5 真探测覆盖；
//     /router/providers/account/discard 与 /router/providers/proxy/key|select、/ports、/self-update/status 的入参校验采样。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-e2e-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

// 产品不再内置 dry-run 测试供应商：测试自行注册本地 mock 反代应用（仅本进程内生效，不进生产）。
// 该注入面是 PROXY_APPS 注册表的落点（原 ensure-instance-test.js 的 PROXY_APPS 覆盖收敛到本文件）。
const { PROXY_APPS: TEST_APPS } = require(path.join(ROOT, 'src', 'domains', 'router', 'proxy-apps'));
const registerCleanup = require(path.join(ROOT, 'test', 'helpers-cleanup'));
function registerDryRunApp() {
  if (TEST_APPS['test-dry-run']) return;
  TEST_APPS['test-dry-run'] = {
    id: 'test-dry-run',
    name: 'Dry (测试)',
    pkg: '(test)',
    command: ['node', path.join(ROOT, 'test', 'dry-run-proxy.js'), '--port', '{{port}}', '--api-key', '{{key}}'],
    healthPath: '/health', modelPath: '/v1/models', upstream: 'http://127.0.0.1:0',
    repo: null, registry: null,
    quota: { type: 'proxy-usage', usagePath: '/usage' },
    real: false,
  };
}
registerDryRunApp();

// 请求助手：连接失败也结算（code=0 → 判红），不把失败变成未捕获错误。
function req(port, method, p, body, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: Object.assign({ 'Content-Type': 'application/json' }, headers) }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', () => resolve({ code: 0, body: '' }));
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// mock 上游：OpenCode 风格 /usage（sk-full → 窗口满额）+ OpenAI 兼容 chat（非流式 / 流式 DONE）
const up = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
    const url = q.url || '';
    const auth = q.headers.authorization || '';
    if (url === '/usage' || url === '/v1/usage') {
      const full = auth.includes('sk-full');
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ usage: { rolling: { status: full ? 'rate-limited' : 'ok', percent: full ? 100 : 15, resetsAt: full ? new Date(Date.now() + 3600000).toISOString() : null }, weekly: { status: 'ok', percent: 20, resetsAt: null }, monthly: { status: 'ok', percent: 30, resetsAt: null } } }));
      return;
    }
    if (url === '/v1/chat/completions') {
      let j = {}; try { j = JSON.parse(b || '{}'); } catch {}
      if (j.stream) {
        s.writeHead(200, { 'Content-Type': 'text/event-stream' });
        s.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        s.write('data: {"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n');
        s.end('data: [DONE]\n\n');
        return;
      }
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ choices: [{ message: { content: 'p2p-ok' } }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }));
      return;
    }
    s.writeHead(404); s.end('nf');
  });
});

(async () => {
  await new Promise((r) => up.listen(28170, '127.0.0.1', r));
  const { RouterService } = require(path.join(ROOT, 'src', 'domains', 'router'));
  const providerFile = path.join(TMP, 'providers.json');
  const svcs = [];
  const svc = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), usageTotalsFile: path.join(TMP, 'totals.json'), logger: { info() {}, warn() {}, error() {} }, events: null });
  svcs.push(svc);
  registerCleanup(() => svcs.flatMap((s) => s.providers || []));

  // -------- A. 直连链路：预设注入 → 真探测入池 → 激活独立端点 → 转发 + 用量记账 --------
  const rA = svc.addDirectProvider({ name: 'Zen', presetId: 'opencode-zen', keys: [] });
  check('A1 预设添加直连', rA.ok === true, JSON.stringify(rA));
  const dp = svc.getProvider(rA.id);
  check('A2 preset 注入 baseUrl/adapter（丢失则直连无法转发）', !!dp.baseUrl && !!dp.adapter, dp.baseUrl);
  dp.baseUrl = 'http://127.0.0.1:28170/v1';
  const aGood = await dp.addAccount('sk-good-001');
  const aFull = await dp.addAccount('sk-full-001');
  check('A4 满额账号 → 直接 frozen 且带恢复点（满额账号不入池）', aFull.ok === true && aFull.limited === 'window' && aFull.account.status === 'frozen' && !!aFull.account.nextResetAt, JSON.stringify({ limited: aFull.limited, status: aFull.account && aFull.account.status, at: aFull.account && aFull.account.nextResetAt }));
  const aFullAcc = dp.accounts.find((a) => a.keyId === aFull.account.keyId);
  // 运行中自动恢复：窗口重置后探测 → applyDetection 自动解冻（与「添加时冻结」同一条状态机，无需人工入池）
  dp.applyDetection(aFullAcc, { ok: true, quota: { rolling: { status: 'ok', percent: 15, resetsAt: null }, weekly: { status: 'ok', percent: 20, resetsAt: null }, monthly: { status: 'ok', percent: 30, resetsAt: null } } });
  check('A5 探测定态：正常账号 ready；窗口重置后满额账号自动 ready 且可挑选（无入池点击）', aGood.ok === true && aGood.account.status === 'ready' && aFullAcc.status === 'ready' && dp.isAccountUsable(aFullAcc) === true, aGood.account.status + '/' + aFullAcc.status);
  dp.activeAccount = null;
  const picked = svc.switcher.pickFor(dp);
  check('A6 账号选择引擎选可用账号', !!picked && picked.keyId === aGood.account.keyId, picked && picked.keyId);
  const disc = dp.discardAccount(aFull.account.keyId);
  check('A7 作废账号移除', disc.ok === true && dp.accounts.length === 1, 'len=' + dp.accounts.length);
  const dup = await dp.addAccount('sk-good-001');
  check('A8 重复添加幂等', dup.already === true && dp.accounts.length === 1, JSON.stringify(dup));

  await svc.activateProvider(rA.id).catch(() => {});
  await svc.start();
  const fwd = await req(dp.apiPort, 'POST', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  const st = await req(dp.apiPort, 'POST', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
  check('A9 直连独立端点转发成功（非流式 + 流式）', fwd.code === 200 && fwd.body.includes('p2p-ok') && st.code === 200 && st.body.includes('DONE'), fwd.code + '/' + st.code);
  check('A10 用量已记账（总量 + 按 key）', svc.getUsage().requests >= 1 && svc.getUsage().totalTokens >= 7 && svc.getUsage().byKey && svc.getUsage().byKey[aGood.account.keyId] && svc.getUsage().byKey[aGood.account.keyId].totalTokens >= 7, JSON.stringify(svc.getUsage()));

  // -------- B. 反代包装器链路（dry-run：真 spawn 子进程）--------
  const rB = svc.addProxyProvider({ name: 'Dry', appId: 'test-dry-run', keys: ['proxy-key-1'] });
  check('B1 反代供应商添加', rB.ok === true, JSON.stringify(rB));
  const pp = svc.getProvider(rB.id);
  check('B2 反代类型/appId', pp.kind === 'proxy' && pp.proxyAppId === 'test-dry-run', pp.kind + '/' + pp.proxyAppId);
  await svc.activateProvider(rB.id).catch(() => {});
  // 轮询等待注册落终态。`registering -> ready` 由实例被拉起的时刻驱动，产品侧不承诺时限，故 deadline 只作失控守卫；
  // 回显耗时/轮询数以便分辨「慢」与「卡死」。
  const wB = { t0: Date.now(), polls: 0 };
  for (;;) {
    wB.polls++;
    const a = pp.accounts.find((x) => x.key === 'proxy-key-1');
    if (a && a.status !== 'registering') break;
    if (Date.now() - wB.t0 >= 60000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const pacc = pp.accounts.find((a) => a.key === 'proxy-key-1');
  const wBe = '耗时=' + (Date.now() - wB.t0) + 'ms 轮询=' + wB.polls + ' 状态=' + JSON.stringify(pacc && pacc.status);
  check('B3 反代账号注册完成', pacc && pacc.status === 'ready', wBe);
  const pinst = pp.instances[0];
  check('B4 真 spawn：一账号一实例且实例有真 pid/port', pp.instances.length === 1 && !!pinst && !!pinst.pid && !!pinst.port, wBe + ' ' + JSON.stringify({ pid: pinst && pinst.pid, port: pinst && pinst.port }));
  const health = await req(pinst.port, 'GET', '/health');
  check('B5 实例探活端点（真 listen + 真子进程应答）', health.code === 200 && health.body.includes('ok'), health.code + ' ' + health.body.slice(0, 40));
  check('B6 反代配额已检测', pinst.quota && pinst.quota.rolling && Number.isFinite(Number(pinst.quota.rolling.percent)), JSON.stringify(pinst.quota));
  // 通过反代供应商独立端点转发（dry-run 返回自己的 OpenAI 兼容响应 = 包装器链路通）
  const fwdP = await req(pp.apiPort, 'POST', '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  check('B7 反代供应商独立端点转发成功', fwdP.code === 200 && fwdP.body.includes('dry-run'), fwdP.code + ' ' + fwdP.body.slice(0, 50));
  const apps = svc.proxyApps();
  check('B9 proxyApps 注册表（PROXY_APPS 单源）', apps.some((a) => a.id === 'commandcode' && a.registry === 'commandcode-api-proxy'), apps.map((a) => a.id + ':' + a.registry).join(','));

  // -------- C. 持久化 round-trip + 重启对账拉起 --------
  await svc.stop(); // 路由停止即停全部反代实例（防子进程残留占用动态端口段）
  const svc2 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), usageTotalsFile: path.join(TMP, 'totals.json'), logger: { info() {}, warn() {}, error() {} }, events: null });
  svcs.push(svc2);
  check('C1 重启后供应商保留', svc2.providers.length === 2, 'len=' + svc2.providers.length);
  const dp2 = svc2.providers.find((p) => p.kind === 'direct');
  const pp2 = svc2.providers.find((p) => p.kind === 'proxy');
  check('C2 重启后直连/反代账号与实例 key 保留', dp2.accounts[0].key === 'sk-good-001' && pp2.accounts[0].key === 'proxy-key-1' && !!pp2.instances[0] && pp2.instances[0].key === 'proxy-key-1', dp2.accounts[0].key + '/' + pp2.accounts[0].key);
  // _ensureProxyInstances 的公开行为面（原 ensure-instance-test.js 私有入口判据的替代）：
  // 进程态不落盘 → start() 后对账必须把「已激活供应商」的实例真拉起（否则重启后反代全哑）。
  const pp2inst = pp2.instances[0];
  await svc2.start();
  const rT0 = Date.now();
  while (!(pp2inst && pp2inst.pid) && Date.now() - rT0 < 30000) await new Promise((r) => setTimeout(r, 250));
  check('C4 重启后对账真拉起实例（进程态不落盘 → 真 pid/port）', !!(pp2inst && pp2inst.pid && pp2inst.port), JSON.stringify({ pid: pp2inst && pp2inst.pid, port: pp2inst && pp2inst.port }));
  await svc2.stop();

  // -------- D. /router/* API 层（原 p2p-api：只留有独立风险的四组）--------
  const cfg = {
    command: ['node', '-e', '0'],
    healthUrl: 'http://127.0.0.1:1/',
    probeIntervalMs: 300, probeTimeoutMs: 1200, failThreshold: 2, startTimeoutMs: 5000,
    stopGraceMs: 800, killWaitMs: 1500, portReleaseWaitMs: 600, crashWindowMs: 10000, crashBurst: 4, backoff: [1500, 3000, 6000],
    apiHost: '127.0.0.1', apiPort: 31930,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'up.log'),
    distDir: path.join(TMP, 'dist'),
    switcherDir: path.join(TMP, 'sw'),
    providerFile: path.join(TMP, 'sw', 'providers.json'),
  };
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const { createServer } = require(path.join(ROOT, 'src', 'api', 'index'));
  const sup = new Supervisor(cfg);
  const server = createServer(sup);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const apiPort = server.address().port;
  const api = (m, p, body) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: apiPort, path: p, method: m, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch {} resolve({ code: res.statusCode, body: j }); });
    });
    r.on('error', () => resolve({ code: 0, body: null }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
  await api('POST', '/router/providers/add', { name: 'Zen', presetId: 'opencode-zen', keys: ['sk-api-1'] });
  const addProxy = await api('POST', '/router/providers/add', { kind: 'proxy', appId: 'test-dry-run', name: 'Dry', keys: ['pk-1'] });
  const proxyPid = addProxy.body && addProxy.body.id;
  await api('POST', '/router/start');
  // 轮询反代账号到终态（capMs 只作失控守卫，不代表产品承诺时限）
  const aT0 = Date.now();
  for (;;) {
    const rr = await api('GET', '/router/providers');
    const ppNow = ((rr.body && rr.body.providers) || []).find((x) => x.kind === 'proxy');
    const aa = (ppNow && ppNow.accounts) || [];
    if (aa.length >= 1 && aa.every((x) => x.status !== 'registering')) break;
    if (Date.now() - aT0 >= 60000) break;
    await new Promise((res) => setTimeout(res, 250));
  }

  // D1-D5 供应商独立端点：默认停用 → 激活分配端口 → 列表地址下沉 → 停用回收 → 视图清除
  let r = await api('GET', '/router/providers');
  const deactView = ((r.body && r.body.providers) || []).find((p) => p.id === proxyPid);
  check('D1 新供应商默认停用（未激活不提供服务）', !!deactView && deactView.activated === false, JSON.stringify(deactView && { activated: deactView.activated, apiBase: deactView.apiBase }));
  r = await api('POST', '/router/providers/activate', { id: proxyPid });
  check('D2 激活供应商分配独立 API 端口', r.code === 200 && r.body.ok === true && typeof r.body.apiPort === 'number', r.code + ' ' + JSON.stringify(r.body));
  r = await api('GET', '/router/providers');
  const actView = ((r.body && r.body.providers) || []).find((p) => p.id === proxyPid);
  check('D3 卡片地址下沉(apiBase)', !!actView && actView.activated === true && !!actView.apiBase, JSON.stringify(actView && { a: actView.activated, api: actView.apiBase }));
  r = await api('POST', '/router/providers/deactivate', { id: proxyPid });
  check('D4 停用回收资源（端点关闭）', r.code === 200 && r.body.ok === true && r.body.activated === false, JSON.stringify(r.body));
  r = await api('GET', '/router/providers');
  const deact2 = ((r.body && r.body.providers) || []).find((p) => p.id === proxyPid);
  check('D5 停用后视图独立地址失效', !!deact2 && !deact2.apiBase, JSON.stringify(deact2 && { apiBase: deact2.apiBase }));

  // D6-D7 keys/set 如实回报（旧实现不 await 检测、恒报 added=1 = 假成功：用户以为加进去了）
  r = await api('GET', '/router/providers');
  const directP = ((r.body && r.body.providers) || []).find((p) => p.kind === 'direct');
  r = await api('POST', '/router/providers/keys/set', { id: directP.id, add: ['sk-api-2'] });
  check('D6 keys/set 如实回报被丢弃的 Key（added=0/discarded=1 且带原因，供 UI 如实提示）', r.code === 200 && r.body.ok === true && r.body.added === 0 && r.body.discarded === 1 && !!(r.body.discardedKeys && r.body.discardedKeys[0] && r.body.discardedKeys[0].error), r.code + ' ' + JSON.stringify(r.body));

  // D8 删除前：router 自治段（proxy/providerApi）须经 /router/ports 可见（S1 契约）
  r = await api('GET', '/router/ports');
  {
    const pvPre = (r.body && r.body.records) || [];
    const proxyPre = pvPre.filter((x) => String(x.owner || '').startsWith('proxy:'));
    const apiPre = pvPre.filter((x) => String(x.owner || '').startsWith('providerApi:'));
    check('D8 删除前 /router/ports 含 router 自治段（proxy+providerApi）', r.code === 200 && proxyPre.length >= 1 && apiPre.length >= 1 && !pvPre.some((x) => String(x.owner || '').startsWith('system:')), r.code + ' recs=' + pvPre.length + ' proxy=' + proxyPre.length + ' api=' + apiPre.length);
  }

  await api('POST', '/router/stop');
  r = await api('POST', '/router/providers/remove', { id: proxyPid });
  check('D9 删除反代供应商', r.code === 200 && r.body.ok === true, r.code + ' ' + JSON.stringify(r.body));
  // D10 local() 应急视图必须带 _stale 标注：daemon 不在时不得把过期数据当实时展示
  {
    const rp = sup.routerProviders();
    const v = rp && rp.then ? await rp : rp;
    check('D10 local() 应急视图带 _stale 标注（防误当实时）', v && v._stale === true && Array.isArray(v.providers), JSON.stringify(v && { stale: v._stale, hasProviders: Array.isArray(v.providers) }));
  }
  // D11 厂商「删除即释放端口」契约（C3 修复）：旧实现 removeProvider 不释放 providerApi/proxy 记录 → 端口登记永久泄漏
  r = await api('GET', '/router/ports');
  {
    const pv = (r.body && r.body.records) || [];
    const leaked = pv.filter((x) => String(x.owner || '').startsWith('providerApi:' + proxyPid) || String(x.owner || '') === 'proxy:' + proxyPid);
    check('D11 删除供应商后其端口登记已释放（无泄漏）', r.code === 200 && leaked.length === 0 && !pv.some((x) => String(x.owner || '').startsWith('system:')), r.code + ' recs=' + pv.length + ' leaked=' + leaked.length);
  }
  server.close();
  up.close();
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
