#!/usr/bin/env node
'use strict';


const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'router-test-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

function req(port, method, reqPath, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: reqPath, method, headers, timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', () => resolve({ code: 0, body: '' }));
    r.end();
  });
}

(async () => {
  const { RouterService } = require(path.join(ROOT, 'src', 'domains', 'router'));
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  const providerFile = path.join(TMP, 'providers.json');
  const svc = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });

  const r1 = svc.addDirectProvider({ name: 'Test Direct', baseUrl: 'https://api.test.com' });
  check('添加直连供应商', r1.ok === true, JSON.stringify(r1));
  const dp = svc.getProvider(r1.id);
  dp.accounts.push({ key: 'sk-test-1', keyId: 'k1', maskedKey: '...est-1', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 20, status: 'ok' }, monthly: { percent: 30, status: 'ok' } }, cooldownUntil: null, registeredAt: Date.now() });
  dp.accounts.push({ key: 'sk-test-2', keyId: 'k2', maskedKey: '...est-2', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 100, status: 'rate-limited' }, monthly: { percent: 100, status: 'rate-limited' } }, cooldownUntil: null, registeredAt: Date.now() });
  svc.store.save(svc.providers);

  const picked = svc.switcher.pickFor(dp);
  check('切换引擎只选可用账号', picked && picked.keyId === 'k1', JSON.stringify(picked && picked.keyId));

  const svc2 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });
  const dp2 = svc2.getProvider(r1.id);
  check('账号状态保留（含供应商随账号一并落盘）', !!dp2 && dp2.accounts.length === 2 && dp2.accounts[0].status === 'ready');

  const { normalizeResetTs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  const ISO_RESET = '2026-09-21T05:54:32.950Z';
  const isMsTs = (v) => typeof v === 'number' && Number.isFinite(v) && v > 1e12 && v < 4e12;
  const nISO = normalizeResetTs(ISO_RESET);
  const nSec = normalizeResetTs('1789970072');
  check('normalizeResetTs：ISO/epoch 秒 → 输入时刻的毫秒时间戳；非法 → null',
    isMsTs(nISO) && nISO === Date.parse(ISO_RESET) && isMsTs(nSec) && nSec % 1000 === 0 && normalizeResetTs('garbage') === null && normalizeResetTs(null) === null,
    nISO + '/' + nSec);

  dp2.activeAccount = dp2.accounts[0]; // 模拟自动在用（未手动锁）
  dp2.selectedAccountKeyId = null;
  const view2 = svc2.listProviders().find((p) => p.id === r1.id);
  const rowSel = view2.accounts.find((a) => a.keyId === 'k1');
  check('未锁定时 activeAccount 在用 → 行 selected=true 且 locked=false/activeKeyId=k1',
    !!rowSel && rowSel.selected === true && view2.locked === false && view2.activeKeyId === 'k1',
    JSON.stringify({ selected: rowSel && rowSel.selected, locked: view2.locked, activeKeyId: view2.activeKeyId }));
  dp2.selectedAccountKeyId = 'k1';
  svc2.store.save(svc2.providers);
  const svc3 = new RouterService({ config: {}, providerFile, portsFile: path.join(TMP, 'ports-router.json'), logger: { info(){}, warn(){}, error(){} }, events: null });
  const dp3 = svc3.getProvider(r1.id);
  check('显式锁定持久化 round-trip（可用账号）', dp3.selectedAccountKeyId === 'k1', String(dp3.selectedAccountKeyId));
  const k2After = dp3.accounts.find((a) => a.keyId === 'k2');
  check('一致性守卫：满额 ready 账号落盘归位 frozen', k2After && k2After.status === 'frozen', JSON.stringify(k2After && k2After.status));
  const view3 = svc3.listProviders().find((p) => p.id === r1.id);
  const k1row = view3.accounts.find((a) => a.keyId === 'k1');
  const k2row = view3.accounts.find((a) => a.keyId === 'k2');
  check('锁收敛：可用账号 locked=true 且高亮；满额冻结账号无锁不亮', k1row && k1row.locked === true && k1row.selected === true && k2row && k2row.locked === false && k2row.selected === false && view3.activeKeyId === 'k1', JSON.stringify({ k1: { l: k1row && k1row.locked, s: k1row && k1row.selected }, k2: { l: k2row && k2row.locked, s: k2row && k2row.selected }, activeKeyId: view3.activeKeyId }));

  const pp = new ProxyProvider({ id: 'p1', name: 'P', kind: 'proxy', proxyAppId: 'test-dry-run', app: { command: ['node', 'x', '--port', '{{port}}', '--api-key', '{{key}}'], healthPath: '/health' }, logger: { info(){}, warn(){}, error(){} }, events: null, dist: null, onPersist: () => {} });
  const i1 = await pp.ensureInstance('key-A');
  const i2 = await pp.ensureInstance('key-A');
  check('一账号一实例：重复 ensure 返回同一实例且实例列表只有一条', i1 === i2 && pp.instances.length === 1, 'len=' + pp.instances.length);

  // 实例级只有 COLD/WARM/HOT/DEAD；「冻结」是账号级语义。
  check('无进程 → isServable=false', i1.isServable() === false, String(i1.isServable()));

  {
    const { UsageLedger } = require(path.join(ROOT, 'src', 'domains', 'router', 'store', 'usage'));
    const mkEntry = (model) => ({ ts: '', model, key: 'sk-x', promptTokens: 1, completionTokens: 1, totalTokens: 2, status: 200 });
    const ledT = new UsageLedger({ file: path.join(TMP, 'usage-t.json'), writeDelayMs: 0 });
    ledT.recordUsage(mkEntry('m'.repeat(200)));
    const keysT = Object.keys(ledT.totals.byModel);
    check('B19 键规整：超长 model 截断至 128、空/非字符串归 unknown', keysT.length === 1 && keysT[0].length === 128 && (() => {
      const l = new UsageLedger({ file: path.join(TMP, 'usage-u.json'), writeDelayMs: 0 });
      l.recordUsage(mkEntry('')); l.recordUsage(mkEntry(null));
      const ks = Object.keys(l.totals.byModel); return ks.length === 1 && ks[0] === 'unknown';
    })(), JSON.stringify(keysT.map((k) => k.length)));
    const runCap = (cap) => {
      const l = new UsageLedger({ file: path.join(TMP, 'usage-c' + cap + '.json'), writeDelayMs: 0, maxModelKeys: cap });
      for (const m of ['a', 'b', 'c', 'd', 'e', 'f']) l.recordUsage(mkEntry(m));
      return l.totals.byModel;
    };
    const byC = runCap(3);
    const byR = runCap(100);
    check('B19 上限生效 + 反向：窄上限溢出并入 (other)，宽上限各自建桶',
      Object.keys(byC).length <= 4 && byC['(other)'] && byC['(other)'].requests === 3 && byC.a && byC.b && byC.c && !byC.d && !byC.e && !byC.f && Object.keys(byR).length === 6 && !byR['(other)'],
      JSON.stringify({ narrow: Object.keys(byC), wide: Object.keys(byR) }));
    // model 名是客户端 body 可控的对象键：__proto__ 会让 byModel 的 [[Prototype]] 被赋值 ⇒ 桶从聚合视图/落盘里消失且后续查找走原型链（静默错账）。
    const ledP = new UsageLedger({ file: path.join(TMP, 'usage-p.json'), writeDelayMs: 0, maxModelKeys: 100 });
    ledP.recordUsage(mkEntry('__proto__'));
    ledP.recordUsage(mkEntry('constructor'));
    ledP.recordUsage(mkEntry('a\u0000b'));
    ledP.recordUsage(mkEntry('real-model'));
    const byP = ledP.totals.byModel;
    check('E-4 危险对象键不重定向 byModel 的原型',
      Object.getPrototypeOf(byP) === Object.prototype, 'proto=' + (Object.getPrototypeOf(byP) === Object.prototype ? 'Object.prototype' : '被改写'));
    check('E-4 违规 model 折进 (other) 且计数不丢（3 违规 + 1 正常 = 4）',
      byP['(other)'] && byP['(other)'].requests === 3 && byP['real-model'] && byP['real-model'].requests === 1 && ledP.totals.requests === 4,
      JSON.stringify({ other: byP['(other)'] && byP['(other)'].requests, keys: Object.keys(byP) }));
    check('E-4 落盘里也不出现危险键', (() => {
      const raw = fs.readFileSync(path.join(TMP, 'usage-p.json'), 'utf8');
      return !/"__proto__"|"constructor"/.test(raw);
    })(), 'clean');
    const fThrottle = path.join(TMP, 'usage-throttle.json');
    try { fs.rmSync(fThrottle, { force: true }); } catch {}
    const ledTh = new UsageLedger({ file: fThrottle, writeDelayMs: 600000 });
    ledTh.recordUsage(mkEntry('z'));
    const throttled = !fs.existsSync(fThrottle);
    ledTh.flush();
    check('B19 节流落盘：未到点不落盘，flush 强制落盘（未到点的账不丢）', throttled && fs.existsSync(fThrottle) && JSON.parse(fs.readFileSync(fThrottle, 'utf8')).requests === 1, 'exists=' + fs.existsSync(fThrottle));
    const fGate = path.join(TMP, 'usage-gate.json');
    try { fs.rmSync(fGate, { force: true }); } catch {}
    const ledG = new UsageLedger({ file: fGate, writeDelayMs: 0, canPersist: () => false });
    ledG.recordUsage(mkEntry('g')); ledG.flush();
    check('B19 落盘仍过 canPersist 单闸（false 时不落盘）', !fs.existsSync(fGate), 'exists=' + fs.existsSync(fGate));
  }

  {
    const { joinUpstream } = require(path.join(ROOT, 'src', 'domains', 'router', 'forward-core'));
    check('joinUpstream：客户端 /v1 去重、无 /v1 时保留并带查询串',
      joinUpstream('http://u.test/v1', '/v1/chat/completions', '') === 'http://u.test/v1/chat/completions'
      && joinUpstream('http://u.test', '/v1/chat/completions', '?a=b') === 'http://u.test/v1/chat/completions?a=b');

    const kAuths = [];
    let kUpstreamMode = 'a-fails';
    const kUp = http.createServer((q, s) => {
      q.on('data', () => {});
      q.on('end', () => {
        kAuths.push(q.headers.authorization);
        if (kUpstreamMode === 'all429' || q.headers.authorization === 'Bearer sk_aaaaaaaaaaaa') {
          s.writeHead(429, { 'Content-Type': 'application/json' });
          s.end(JSON.stringify({ error: { message: 'usage limit' } }));
        } else {
          s.writeHead(200, { 'Content-Type': 'application/json' });
          s.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise((r) => kUp.listen(3993, '127.0.0.1', r));

    const ksvc = new RouterService({
      config: {},
      providerFile: path.join(TMP, 'router-providers.json'),
      portsFile: path.join(TMP, 'ports-keypool.json'),
      usageTotalsFile: path.join(TMP, 'sw-totals.json'),
      logger: { info() {}, warn() {}, error() {} },
      events: null,
    });
    const kpr = ksvc.addDirectProvider({ name: 'T', baseUrl: 'http://127.0.0.1:3993/v1' });
    const kdp = ksvc.getProvider(kpr.id);
    kdp.accounts.push({ key: 'sk_aaaaaaaaaaaa', keyId: 'k1', maskedKey: '...aaaa', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 20, status: 'ok' }, monthly: { percent: 30, status: 'ok' } }, cooldownUntil: null, registeredAt: Date.now() });
    kdp.accounts.push({ key: 'sk_bbbbbbbbbbbb', keyId: 'k2', maskedKey: '...bbbb', status: 'ready', quota: { rolling: { percent: 10, status: 'ok' }, weekly: { percent: 20, status: 'ok' }, monthly: { percent: 30, status: 'ok' } }, cooldownUntil: null, registeredAt: Date.now() });
    await ksvc.activateProvider(kpr.id); // 供应商独立端点语义：激活即开放该供应商独立 API 端口（未激活不提供服务）
    await ksvc.start();

    const kr1 = await req(kdp.apiPort, 'POST', '/v1/chat/completions');
    check('额度尽自动切换次 Key 并透传成功', kr1.code === 200 && JSON.stringify(kAuths) === '["Bearer sk_aaaaaaaaaaaa","Bearer sk_bbbbbbbbbbbb"]', JSON.stringify(kAuths));
    const kst = ksvc.status();
    check('额度尽 → 账号冻结且活跃键切换为次 Key（...bbbb）', kst.providers[0].accounts[0].status === 'frozen' && kst.providers[0].accounts[1].status === 'ready' && kdp.activeAccount && kdp.activeAccount.maskedKey === '...bbbb', JSON.stringify(kst.providers[0].accounts));

    const kr2 = await req(kdp.apiPort, 'POST', '/v1/chat/completions');
    check('冻结后粘滞活跃键直接复用可用键（无冷却态）', kr2.code === 200 && kAuths.length === 3 && kAuths[2] === 'Bearer sk_bbbbbbbbbbbb', JSON.stringify(kAuths));

    kUpstreamMode = 'all429';
    kdp.accounts[0].status = 'frozen';
    kdp.accounts[1].status = 'frozen';
    const kr3 = await req(kdp.apiPort, 'POST', '/v1/chat/completions');
    check('全部限额（冻结）时返回 429', kr3.code === 429 && kr3.body.includes('all accounts exhausted'), kr3.code + ' ' + kr3.body);

    const kuBefore = ksvc.getUsage();
    ksvc.recordUsage({ ts: '', model: 'test-model', key: 'sk-xx', promptTokens: 100, completionTokens: 50, totalTokens: 150, durationMs: 5, status: 200 });
    const ku = ksvc.getUsage();
    const ktm = ku.byModel.find((m) => m.model === 'test-model');
    check('用量记录与按模型聚合', ku.requests === kuBefore.requests + 1 && ku.totalTokens === kuBefore.totalTokens + 150 && !!ktm, JSON.stringify(ku));

    await ksvc.stop();
    if (typeof kUp.closeAllConnections === 'function') kUp.closeAllConnections();
    await new Promise((r) => kUp.close(r));
  }


  {
    // W3：router 域（ops/apps-registry.js）此前内联抄了一份三元式，现已取 shared 单源。
    // 该域没有别的测试钉这条映射 ⇒ 在此钉住，并证源码里内联副本已零残留。
    const tsShared = require(path.join(ROOT, 'src', 'shared', 'task-state'));
    const src = fs.readFileSync(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'apps-registry.js'), 'utf8');
    const inlineLeft = (src.match(/t\.state === 'succeeded'/g) || []).length;
    check('W3-D router 域不再内联任务态三元式（零残留）且映射取 shared 单源',
      inlineLeft === 0 && /shared\/task-state/.test(src) && tsShared.taskStateToView('canceled') === 'failed',
      'inline=' + inlineLeft + ' requires=' + /shared\/task-state/.test(src));
  }


  {
    // W3：账号拆除曾有四份（process-pool 的 onDiscardAccount 钩子 + admin.js 两处手写），
    // 手写版绕过钩子 ⇒ 已实际分叉（漏摘 instances、漏 account_discarded 事件）。
    // 合并后没有任何测试走过这条路径（突变 teardown 成空操作 ⇒ 全部测试仍绿）⇒ 在此钉住。
    const { createAdminOps } = require(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'admin'));
    const hookCalls = [];
    const mkP = (withHook) => ({
      _hooks: withHook ? { onDiscardAccount: (acc) => hookCalls.push(acc.keyId) } : {},
      accounts: [{ keyId: 'k1', maskedKey: '***k1', instance: { port: 3999 } }],
      instances: [{ keyId: 'k1', port: 3999 }],
      supports: () => true,
      stopInstance() {}, _persist() {},
    });
    const ops = createAdminOps({ findProvider: () => mkP(true), save: () => {}, maskKey: (k) => k });
    // 走 removeProxyKey：必须经钩子拆实例（而不是自己手写一遍 stop/unregister）
    const p1 = mkP(true);
    const ops1 = createAdminOps({ findProvider: () => p1, save: () => {}, maskKey: (k) => k });
    const r1 = ops1.removeProxyKey('any', 'k1');
    check('W3-E 账号拆除统一经 onDiscardAccount 钩子（不再手写一份 stop/unregister）',
      r1.ok === true && hookCalls.length === 1 && hookCalls[0] === 'k1' && p1.accounts.length === 0,
      'hook=' + JSON.stringify(hookCalls) + ' accounts=' + p1.accounts.length);
    // 无钩子（直连供应商）：不得抛错，且仍把账号摘掉、实例表清干净（不因缺钩子而漏收尾）
    const p2 = mkP(false);
    const ops2 = createAdminOps({ findProvider: () => p2, save: () => {}, maskKey: (k) => k });
    const r2 = ops2.removeProxyKey('any', 'k1');
    check('W3-F 无钩子（直连供应商）拆除不抛错：账号摘除且实例表清干净（不对直连误触 stopInstance）',
      r2.ok === true && p2.accounts.length === 0 && p2.instances.length === 0,
      JSON.stringify({ ok: r2.ok, accounts: p2.accounts.length, instances: p2.instances.length }));
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
