#!/usr/bin/env node
'use strict';

// 智能路由端到端（路由域收敛宿主）：前段 RouterService 直连/反代链路（真 listen mock 上游 + 真 spawn dry-run：
//   预设注入 → 真探测入池 → 激活独立端点 → 转发/用量记账 → 反代实例真启停 → 持久化 round-trip → 重启后对账拉起）；
//   后段完整 Supervisor + api.js 的 /router/*（供应商端点生命周期、keys/set 如实回报、删除即释放端口登记、local() 应急视图 _stale 标注）。

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-e2e-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

// dry-run 测试供应商由测试自行注册本地 mock 反代应用（仅本进程内生效，不进生产），注入面是 PROXY_APPS 注册表；
//   直连侧同理落 PROVIDER_PRESETS（registerLocalUpstreamPreset）——本文件所有上游都必须是本机 mock。
const { PROXY_APPS: TEST_APPS } = require(path.join(ROOT, 'src', 'domains', 'router', 'proxy-apps'));
const { PROVIDER_PRESETS } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
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

// 直连供应商的同类注入落点（PROVIDER_PRESETS）：D 段只需要一个「上游在本机 mock」的直连预设。
// 用生产目录（opencode-zen 指向公网）会让 D6 的 added/discarded 取决于公网服务对伪造 Key 的答复——
// 非确定性，且违背本文件「所有网络目标均为本机 mock」的纪律。仅本进程内生效，不进生产。
function registerLocalUpstreamPreset() {
  if (PROVIDER_PRESETS.some((p) => p.id === 'test-local-upstream')) return;
  PROVIDER_PRESETS.push({
    id: 'test-local-upstream',
    name: 'Local Upstream (测试)',
    baseUrl: 'http://127.0.0.1:28170/v1',
    plan: null,
    // window-usage：检测走 baseUrl + usagePath，上游 5xx/不可达即「取不到配额」→ 如实丢弃该 Key。
    adapter: { quota: { type: 'window-usage', usagePath: '/usage' } },
    pricing: {},
  });
}
registerLocalUpstreamPreset();

// D 段的反代账号 Key 是**固定装置**：dry-run 反代按 Key 哈希派生 5h/周/月三窗口百分比，取到满额窗口的 Key
//   会被产品**正确地**判为 frozen ⇒ 期望集只收 ready，实例永不拉起，'proxy:<keyId>' 端口登记永不出现，
//   D8 的 proxy 段收敛条件不可达（不是「CI 慢」）。故用 'proxy-key-d8'（三窗口全 < 100）。
const PROXY_OK_KEY = 'proxy-key-d8';

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

// mock 上游：OpenCode 风格 /usage（sk-full → 窗口满额；sk-down → 检测面 5xx）+ OpenAI 兼容 chat（非流式 / 流式 DONE）
const up = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => b += c); q.on('end', () => {
    const url = q.url || '';
    const auth = q.headers.authorization || '';
    if (url === '/usage' || url === '/v1/usage') {
      // sk-down*：模拟上游检测面 5xx —— 该 Key 取不到配额（det.ok=false），keys/set 必须如实丢弃并带原因。
      // （当前产品里「丢弃」只剩这一条入口：坏 Key 的 401/403 属封号语义，入库为 banned 而非丢弃。）
      if (auth.includes('sk-down')) { s.writeHead(500, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ error: 'usage unavailable' })); return; }
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
    // 隔离的唯一开关是 stateFile：守卫按 dirname(stateFile) 派生 providers.json / ports.json（switcherDir/
    //   providerFile 只服务于直连构造的 RouterService）。必须与本段 providerFile 同址，否则守卫复用 A/B/C 段的供应商。
    stateFile: path.join(TMP, 'sw', 'state.json'),
    logFile: path.join(TMP, 'events.log'),
    supervisorLogFile: path.join(TMP, 'sup.log'),
    dshLogFile: path.join(TMP, 'dsh.log'),
    upgradeLogFile: path.join(TMP, 'up.log'),
    distDir: path.join(TMP, 'dist'),
    switcherDir: path.join(TMP, 'sw'),
    providerFile: path.join(TMP, 'sw', 'providers.json'), // 与 stateFile 派生路径同址（守卫只认 stateFile）
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
  // 直连供应商走测试预设（上游=本机 mock，见 registerLocalUpstreamPreset），不碰公网
  await api('POST', '/router/providers/add', { name: 'Zen', presetId: 'test-local-upstream', keys: ['sk-api-1'] });
  // Key 必须让 dry-run 反代自报「三窗口均不满额」（见文件头 PROXY_OK_KEY）：满额 Key 会让账号被正确冻结，
  // D8 的 proxy 段随即不可达（该次失败与端口登记实现无关，只与这个固定装置有关）。
  const addProxy = await api('POST', '/router/providers/add', { kind: 'proxy', appId: 'test-dry-run', name: 'Dry', keys: [PROXY_OK_KEY] });
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
  // 激活即异步拉该供应商的实例（产品不承诺时限），实例端口认领后才有 proxy: 登记，故有界等待它落表；
  //   30s 是 15 倍余量（同链路在 ubuntu runner 上约 2s）。等满 30s 仍无 proxy: 段 = 账号根本不在期望集（frozen/discarded），必须查因。
  const wProxy = { t0: Date.now(), polls: 0 };
  for (;;) {
    wProxy.polls++;
    const rp = await api('GET', '/router/ports');
    if (((rp.body && rp.body.records) || []).some((x) => String(x.owner || '').startsWith('proxy:'))) break;
    if (Date.now() - wProxy.t0 >= 30000) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  r = await api('GET', '/router/providers');
  const actView = ((r.body && r.body.providers) || []).find((p) => p.id === proxyPid);
  check('D3 卡片地址下沉(apiBase)', !!actView && actView.activated === true && !!actView.apiBase, JSON.stringify(actView && { a: actView.activated, api: actView.apiBase }));
  r = await api('POST', '/router/providers/deactivate', { id: proxyPid });
  check('D4 停用回收资源（端点关闭）', r.code === 200 && r.body.ok === true && r.body.activated === false, JSON.stringify(r.body));
  r = await api('GET', '/router/providers');
  const deact2 = ((r.body && r.body.providers) || []).find((p) => p.id === proxyPid);
  check('D5 停用后视图独立地址失效', !!deact2 && !deact2.apiBase, JSON.stringify(deact2 && { apiBase: deact2.apiBase }));

  // D6-D7 keys/set 如实回报：判据是「检测拿不到配额 → 该 Key 被丢弃且带原因」这一外部可观测后果
  //   （sk-down 由本机 mock 恒返 5xx，与公网无关；added/discarded 不随 CI 出网情况漂移）。
  r = await api('GET', '/router/providers');
  const directP = ((r.body && r.body.providers) || []).find((p) => p.kind === 'direct');
  r = await api('POST', '/router/providers/keys/set', { id: directP.id, add: ['sk-down-1'] });
  check('D6 keys/set 如实回报被丢弃的 Key（added=0/discarded=1 且带原因，供 UI 如实提示）', r.code === 200 && r.body.ok === true && r.body.added === 0 && r.body.discarded === 1 && !!(r.body.discardedKeys && r.body.discardedKeys[0] && r.body.discardedKeys[0].error), r.code + ' ' + JSON.stringify(r.body));

  // D8 删除前：router 自治段（proxy/providerApi）须经 /router/ports 可见（S1 契约）
  r = await api('GET', '/router/ports');
  {
    const pvPre = (r.body && r.body.records) || [];
    const proxyPre = pvPre.filter((x) => String(x.owner || '').startsWith('proxy:'));
    const apiPre = pvPre.filter((x) => String(x.owner || '').startsWith('providerApi:'));
    // 失败自证：proxy 段缺席时把该供应商的账号终态/配额/实例态一并回报，读日志的人不必在「慢」与「条件不可达」之间猜。
    let why = '';
    if (!proxyPre.length) {
      const rv = await api('GET', '/router/providers');
      const pvDry = ((rv.body && rv.body.providers) || []).find((p) => p.id === proxyPid);
      const acc = (pvDry && pvDry.accounts && pvDry.accounts[0]) || null;
      why = ' 账号=' + JSON.stringify(acc && { status: acc.status, usable: acc.usable, quotaStatus: acc.quotaStatus, limitKind: acc.limit && acc.limit.kind, detectError: acc.detectError, quota: acc.quota }) + ' 实例=' + JSON.stringify((pvDry && pvDry.instances) || []);
    }
    check('D8 删除前 /router/ports 含 router 自治段（proxy+providerApi）', r.code === 200 && proxyPre.length >= 1 && apiPre.length >= 1 && !pvPre.some((x) => String(x.owner || '').startsWith('system:')), r.code + ' recs=' + pvPre.length + ' proxy=' + proxyPre.length + ' api=' + apiPre.length + ' 实例端口等待=' + (Date.now() - wProxy.t0) + 'ms/' + wProxy.polls + '轮' + why);
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
  // D11 厂商「删除即释放端口」契约：removeProvider 必须释放 providerApi/proxy 记录，否则端口登记永久泄漏。
  r = await api('GET', '/router/ports');
  {
    const pv = (r.body && r.body.records) || [];
    const owners = pv.map((x) => String(x.owner || ''));
    // 本段守卫内只有一个反代供应商（Dry）与一个未激活的直连供应商（Zen），删除后残留的任何 proxy: 段都是泄漏。
    //   owner 必须是 'proxy:<账号 keyId>'（providers/probe.js:54-55 claimSlot），用供应商 id 拼会恒不匹配（空判据）。
    const leaked = owners.filter((o) => o.startsWith('proxy:') || o.startsWith('providerApi:' + proxyPid));
    check('D11 删除供应商后其端口登记已释放（无泄漏）', r.code === 200 && leaked.length === 0 && !owners.some((o) => o.startsWith('system:')), r.code + ' recs=' + pv.length + ' leaked=' + leaked.length + ' owners=' + JSON.stringify(owners));
  }
  // E. 装配期端口账本：自愈写口（allocateMark）与顺序（configureFile 先于构造）各判一次 —— 根因① 写口用错
  //   API（registerUser 带「动态保留池」守卫，而 providerApi 段 24000-25999 本身在该池内 ⇒ 池内号必抛且被
  //   try/catch 吞掉）；根因② 注册表是进程级单例、最后一个 configureFile 生效。R_IN(24001) 判①，R_OUT(26001) 判②。
  {
    const { shared: sharedPorts } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
    require(path.join(ROOT, 'src', 'domains', 'router', 'port-segments')); // 段/池申报（require 即申报、幂等）：R_IN 的「池内」语义依赖它
    const rSw = path.join(TMP, 'restart');
    fs.mkdirSync(rSw, { recursive: true });
    const rPrev = path.join(TMP, 'restart-prev', 'ports.json');
    sharedPorts.configureFile(rPrev); // 扮演装配前进程内仍生效的既有账（生产=默认状态根）
    // 池基线从代码申报取（不写字面量）：池基线漂移时判据不会静默失效
    const rRange = sharedPorts.rangeOf('providerApi');
    const R_IN = rRange.base + 1;                    // 池内（24001）
    const R_OUT = rRange.base + rRange.count + 1;    // 池外（26001）：构造期 configurePools 尚未生效（domains.js:39 在构造之后）
    // 落盘的持久状态：两个供应商均已激活、apiPort 已定 —— 重启后装配读到的 providers.json。
    const rProv = (id, port) => ({
      id, name: id, kind: 'direct', baseUrl: 'http://127.0.0.1:1/v1',
      apiPort: port, activated: true, plan: null, pricing: {}, presetId: null,
      adapter: { quota: { type: 'window-usage', usagePath: '/usage' } },
      proxyAppId: null, proxyRunning: false, selectedAccountKeyId: null, activeAccountKeyId: null,
      accounts: [], instances: [],
    });
    fs.writeFileSync(path.join(rSw, 'providers.json'), JSON.stringify({ providers: [
      rProv('prov-restart-in', R_IN), rProv('prov-restart-out', R_OUT),
    ] }));
    const rSup = new Supervisor({
      command: ['node', '-e', '0'],
      healthUrl: 'http://127.0.0.1:31940/',
      apiHost: '127.0.0.1', apiPort: 31941,
      stateFile: path.join(rSw, 'state.json'),
      logFile: path.join(rSw, 'events.log'), supervisorLogFile: path.join(rSw, 'sup.log'),
      dshLogFile: path.join(rSw, 'dsh.log'), upgradeLogFile: path.join(rSw, 'up.log'),
      distDir: path.join(rSw, 'dist'),
      // 刻意**不**覆盖 portPools：池基线保持代码申报值，R_IN 才是真池内号（覆盖会把 24000 段挪走，
      //   判据就失去根因①的牙齿）。
    });
    const rRecs = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).records || []; } catch { return []; } };
    const rLoaded = (rSup.router.providers || []).map((p) => ({ id: p.id, apiPort: p.apiPort, activated: p.activated }));
    const rActive = rRecs(path.join(rSw, 'ports.json'));
    const rOld = rRecs(rPrev);
    // 前置自证：两个持久化 apiPort 必须真的被加载，否则下面三条会因"没有供应商可补登记"而空转成绿。
    check('E0 重启装配读到上一轮的供应商与 apiPort（前置自证，防判据空转）',
      rLoaded.length === 2 && rLoaded.some((x) => x.apiPort === R_IN) && rLoaded.some((x) => x.apiPort === R_OUT),
      'R_IN=' + R_IN + ' R_OUT=' + R_OUT + ' ' + JSON.stringify(rLoaded));
    // 池内号：旧写口 registerUser 会被保留池守卫拒绝（pool.js:113-114）且异常被吞 ⇒ 此格必红。
    check('E1a 池内持久化 apiPort 经自愈写口落进活动账本（allocateMark；旧写口下必红）',
      rActive.some((x) => x.port === R_IN && x.owner === 'providerApi:prov-restart-in' && x.role === 'providerApi')
      && sharedPorts.byOwner('providerApi:prov-restart-in') === R_IN,
      'active=' + JSON.stringify(rActive.map((x) => x.port + ':' + x.owner)));
    // 池外号两代写口都接受，故它只判「顺序」—— 顺序错时它会被写进 rPrev 而活动账本为空。
    check('E1b 池外持久化 apiPort 同样落进活动账本（此格与 E1a 互补：只判顺序，不判写口 API）',
      rActive.some((x) => x.port === R_OUT && x.owner === 'providerApi:prov-restart-out')
      && sharedPorts.byOwner('providerApi:prov-restart-out') === R_OUT,
      'active=' + JSON.stringify(rActive.map((x) => x.port + ':' + x.owner)));
    // 旧账必须一条记录都没有：顺序错时这里会出现 providerApi: / system: 记录（串账到默认状态根/他人账本）。
    check('E2 装配前仍生效的旧账完全未被写入（不向默认状态根/他人账本串账）',
      rOld.length === 0,
      'prev=' + JSON.stringify(rOld.map((x) => x.port + ':' + x.owner)));
  }

  server.close();
  up.close();
  const failed = results.filter((x) => !x);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
