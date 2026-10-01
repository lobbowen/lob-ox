#!/usr/bin/env node
'use strict';


const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-recovery-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };

(async () => {
  const { ProxyProvider } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'proxy'));
  const ports = require(path.join(ROOT, 'src', 'platform', 'service', 'ports')).shared;
  ports.configureFile(path.join(TMP, 'ports-router.json'));
  const log = { info(){}, warn(){}, error(){}, debug(){} };

  let billingState = {
    limited: true,
    exceeded: 'fiveHour',
    fiveHour: { used: 3.1, cap: 3, exceeded: true, resetAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() }, // 2h 后重置
    weekly: { used: 1, cap: 6, exceeded: false, resetAt: null },
  };
  let billingHits = 0; // billing server 被请求次数（验证补探测）
  let subHits = 0;     // subscriptions 面被请求次数（D 组：防风控判据）
  let creditsReply = () => ({
    credits: { monthlyCredits: 0.5, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
    windowLimits: billingState,
  });
  let subReply = null;  // 订阅面报文（null -> 与 credits 面同形，解析不到 currentPeriodEnd）
  let subStatus = 200;
  const billing = http.createServer((req, res) => {
    billingHits++;
    const isSub = String(req.url || '').includes('/alpha/billing/subscriptions');
    if (isSub) subHits++;
    const status = isSub ? subStatus : 200;
    const payload = isSub ? (subReply || creditsReply()) : creditsReply();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 200 ? JSON.stringify(payload) : '{}');
  });
  await new Promise((r) => billing.listen(0, '127.0.0.1', r));
  const billingPort = billing.address().port;
  const billingBase = 'http://127.0.0.1:' + billingPort;

  // 夹具必须与生产配置 proxy-apps.js 对齐：缺 subscriptionsPath 会让订阅面永远走常量回退，缺 windowMap.monthly 则 monthly 窗口语义漂移。
  const app = {
    id: 'cc-test', name: 'CC Test', real: false,
    command: ['node', '/bin/true'],
    upstream: 'http://127.0.0.1:0',
    quota: {
      type: 'commandcode-billing', apiBase: billingBase, creditsPath: '/alpha/billing/credits',
      subscriptionsPath: '/alpha/billing/subscriptions',
      windowMap: { rolling: 'fiveHour', weekly: 'weekly', monthly: null },
      monthlyCapUsd: 10,
    },
  };

  async function mkProvider(id) {
    const p = new ProxyProvider({ id, name: id, kind: 'proxy', proxyAppId: 'cc-test', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    return p;
  }
  async function addAcc(p, key) {
    const inst = await p.ensureInstance(key);
    const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: 'ready', quota: null, registeredAt: Date.now() };
    p.accounts.push(acc);
    p.instances.push(inst);
    return { p, inst, acc };
  }

  console.log('== 修复 A：markQuotaExhausted 用 429 body 的精确 ISO 恢复点（非默认 +5h）==');
  {
    const { p, acc } = await addAcc(await mkProvider('pa'), 'sk-freeze-a');
    // 429 body 样本与 upstream-credits-test.js 去重：那边只证「解析对」，此处只证解析结果真被消费成 nextResetAt / status。
    const bodyText = JSON.stringify({ error: { message: 'CC API 429: rate limited, resets at ' + new Date(Date.now() + 2 * 3600 * 1000).toISOString() + '. Please wait.' } });
    const { bodyResetMs, headerRetryMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
    const retryMs = bodyResetMs(bodyText);
    p.markQuotaExhausted(acc, headerRetryMs({}) || retryMs);
    check('A3/A4 冻结恢复点 = body 的精确 ISO（≈now+2h 非 +5h 默认），状态 frozen + limit.window',
      acc.nextResetAt > Date.now() + 1.8 * 3600 * 1000 && acc.nextResetAt < Date.now() + 2.2 * 3600 * 1000
      && acc.status === 'frozen' && !!acc.limit && acc.limit.kind === 'window', String(acc.nextResetAt));
    // 各组之间等定时器排空再清理，防跨组定时器交错污染计数。
    await new Promise((r) => setTimeout(r, 450));
    billingHits = 0;
  }

  console.log('== 修复 B：429/400 冻结后 _probeAfterResponseFreeze 自动补探测（quota 不再 stale）==');
  {
    const { p, inst, acc } = await addAcc(await mkProvider('pb'), 'sk-freeze-b');
    const hitsBefore = billingHits;
    p.markQuotaExhausted(acc, 5 * 3600 * 1000);
    await new Promise((r) => setTimeout(r, 800));
    check('B2 补探测已访问 billing server（冻结后 quota 不再 stale）', billingHits > hitsBefore, 'hits ' + hitsBefore + '→' + billingHits);
    const rl = (acc.quota || inst.quota || {}).rolling;
    check('B3/B4 补探测后 rolling = 100%/rate-limited，nextResetAt 收敛到 billing 的 resetAt（官方精确）',
      !!rl && rl.status === 'rate-limited' && rl.percent === 100
      && Math.abs(acc.nextResetAt - new Date(billingState.fiveHour.resetAt).getTime()) < 2000,
      JSON.stringify(rl) + ' nextResetAt=' + acc.nextResetAt);
    await new Promise((r) => setTimeout(r, 450));
    billingHits = 0;
  }

  console.log('== 修复 B 自愈：补探测发现未超限 → applyDetection 自动解冻 ==');
  {
    const { p, acc } = await addAcc(await mkProvider('pc'), 'sk-freeze-c');
    billingState = { limited: false, exceeded: null, fiveHour: { used: 0.5, cap: 3, exceeded: false, resetAt: new Date(Date.now() + 3600 * 1000).toISOString() }, weekly: { used: 1, cap: 6, exceeded: false, resetAt: null } };
    const hitsC = billingHits;
    p.markQuotaExhausted(acc, 5 * 3600 * 1000);
    for (let w = 0; w < 30 && billingHits === hitsC; w++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300)); // 让 applyDetection 落定
    check('C1/C2/C3 billing 恢复健康 → 补探测自动解冻 ready、limit 清空、quota 刷新为健康（rolling 未满）',
      acc.status === 'ready' && !acc.limit && !!(acc.quota && acc.quota.rolling) && acc.quota.rolling.status === 'ok',
      'status=' + acc.status + ' limit=' + JSON.stringify(acc.limit));
  }

  console.log('== D：commandcode-billing 上游报文契约（credits 面 + 订阅面）==');
  {
    creditsReply = () => ({
      windowLimits: { fiveHour: { cap: 2000, used: 200, resetAt: Date.now() + 3600000 }, weekly: { cap: 100, used: 100, resetAt: Date.now() + 604800000 } },
      credits: { monthlyCredits: 4, purchasedCredits: 0, freeCredits: 0 },
    });
    subReply = null;
    const d1 = await addAcc(await mkProvider('pd1'), 'sk-quota-d1');
    const r1 = await d1.p.detectInstanceQuota(d1.inst);
    check('D1 周 100% 无 exceeded → rate-limited（不再 status:ok 矛盾）',
      r1.ok && d1.inst.quota.weekly.status === 'rate-limited' && d1.inst.quota.weekly.percent === 100, JSON.stringify(d1.inst.quota.weekly));

    creditsReply = () => ({ data: { windowLimits: { fiveHour: { cap: 10, used: 10, resetAt: null } }, credits: {} } });
    const d2 = await addAcc(await mkProvider('pd2'), 'sk-quota-d2');
    const r2 = await d2.p.detectInstanceQuota(d2.inst);
    check('D2 data 信封解包 → 5h 100% rate-limited',
      r2.ok && d2.inst.quota.rolling.status === 'rate-limited' && d2.inst.quota.rolling.percent === 100, JSON.stringify(d2.inst.quota.rolling));

    creditsReply = () => ({ windowLimits: { fiveHour: { cap: '2000', used: '300', resetAt: Date.now() + 3600000 }, weekly: { cap: '100', used: '50', resetAt: null } } });
    const d3 = await addAcc(await mkProvider('pd3'), 'sk-quota-d3');
    const r3 = await d3.p.detectInstanceQuota(d3.inst);
    check('D3 字符串 used/cap 解析 → 5h 15% ok',
      r3.ok && d3.inst.quota.rolling.percent === 15 && d3.inst.quota.rolling.status === 'ok', JSON.stringify(d3.inst.quota.rolling));

    const periodEnd = Date.now() + 23 * 24 * 3600 * 1000;
    creditsReply = () => ({
      credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { fiveHour: { cap: 3, used: 0.87 }, weekly: { cap: 6, used: 3.9 } },
    });
    subReply = { success: true, data: { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(periodEnd).toISOString(), planId: 'individual-go' } };
    const d4 = await addAcc(await mkProvider('pd4'), 'sk-quota-d4');
    const r4 = await d4.p.detectInstanceQuota(d4.inst);
    check('D4 credits-limited 取订阅 → monthlyResetAt = currentPeriodEnd',
      r4.ok && d4.inst.quota.monthlyResetAt === periodEnd, JSON.stringify({ mr: d4.inst.quota.monthlyResetAt, periodEnd }));

    subReply = { success: true, data: { status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 25 * 24 * 3600 * 1000).toISOString() } };
    const d5 = await addAcc(await mkProvider('pd5'), 'sk-quota-d5');
    const r5 = await d5.p.detectInstanceQuota(d5.inst);
    check('D5 cancelAtPeriodEnd → monthlyResetAt=null（回退轮询，不赌续订）',
      r5.ok && d5.inst.quota.monthlyResetAt === null, JSON.stringify(d5.inst.quota.monthlyResetAt));

    subHits = 0;
    subReply = { success: true, data: { currentPeriodEnd: new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString() } };
    creditsReply = () => ({
      credits: { monthlyCredits: 6.08 },
      windowLimits: { fiveHour: { cap: 3, used: 0.1 }, weekly: { cap: 6, used: 3.9 } },
    });
    const d6 = await addAcc(await mkProvider('pd6'), 'sk-quota-d6');
    const r6 = await d6.p.detectInstanceQuota(d6.inst);
    check('D6 额度充足 → 不取订阅（subHits=0）且 monthlyResetAt=null',
      r6.ok && subHits === 0 && d6.inst.quota.monthlyResetAt === null, JSON.stringify({ subHits, mr: d6.inst.quota.monthlyResetAt }));

    creditsReply = () => ({
      credits: { monthlyCredits: 0.5, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: billingState,
    });
    subReply = null; subStatus = 200;
  }

  billing.close();
  const failed = results.filter((r) => !r).length;
  console.log('==============================');
  console.log('结果: ' + results.length + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.stack || e); process.exit(1); });
