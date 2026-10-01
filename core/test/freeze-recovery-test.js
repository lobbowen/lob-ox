#!/usr/bin/env node
'use strict';

// 响应驱动冻结机制端到端验证：markQuotaExhausted 恢复点 = 上游 429 body 的精确 ISO 时间（非默认 +5h）；
//   冻结后 _probeAfterResponseFreeze 自动补探测刷新 quota + 未超限时自动解冻；
//   commandcode-billing 上游报文契约。方法：本地 mock billing（credits + subscriptions 两路）+ 真实 ProxyProvider，不 spawn 真实实例。

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

  // -- mock Command billing：可编程响应（credits 面 / subscriptions 面各一路）--
  let billingState = {
    limited: true,
    exceeded: 'fiveHour',
    fiveHour: { used: 3.1, cap: 3, exceeded: true, resetAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() }, // 2h 后重置
    weekly: { used: 1, cap: 6, exceeded: false, resetAt: null },
  };
  let billingHits = 0; // billing server 被请求次数（验证补探测）
  let subHits = 0;     // subscriptions 面被请求次数（D 组：防风控判据）
  // credits 面默认报文（A/B/C 组消费；D 组逐场景改写）
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

  // fixture 必须与生产配置（proxy-apps.js）对齐：缺 subscriptionsPath 会让订阅面永远走常量回退，
  //   缺 windowMap.monthly 则 monthly 窗口语义漂移 —— 那样测的就不是生产路径。
  const app = {
    id: 'cc-test', name: 'CC Test', real: false,
    command: ['node', '/bin/true'], // 不真实 spawn
    upstream: 'http://127.0.0.1:0',
    quota: {
      type: 'commandcode-billing', apiBase: billingBase, creditsPath: '/alpha/billing/credits',
      subscriptionsPath: '/alpha/billing/subscriptions',
      windowMap: { rolling: 'fiveHour', weekly: 'weekly', monthly: null },
      monthlyCapUsd: 10,
    },
  };

  // 独立测试区（互不干扰）
  async function mkProvider(id) {
    const p = new ProxyProvider({ id, name: id, kind: 'proxy', proxyAppId: 'cc-test', app, logger: log, events: null, dist: null, onPersist: () => {} });
    p.activated = true;
    return p;
  }
  async function addAcc(p, key) {
    const inst = await p.ensureInstance(key); // 只建对象不 spawn
    const acc = { key, keyId: inst.keyId, maskedKey: '...' + key.slice(-6), status: 'ready', quota: null, registeredAt: Date.now() };
    p.accounts.push(acc);
    p.instances.push(inst);
    return { p, inst, acc };
  }

  // --- 修复 A：429 body ISO 精确恢复点 ---
  console.log('== 修复 A：markQuotaExhausted 用 429 body 的精确 ISO 恢复点（非默认 +5h）==');
  {
    const { p, acc } = await addAcc(await mkProvider('pa'), 'sk-freeze-a');
    // 429 body：与 upstream-credits-test.js 的同型样本去重（那边只证「解析对」，此处只证
    //   解析结果被真正消费成 nextResetAt / status —— 两层不同风险，判据必须留下）。
    const bodyText = JSON.stringify({ error: { message: 'CC API 429: rate limited, resets at ' + new Date(Date.now() + 2 * 3600 * 1000).toISOString() + '. Please wait.' } });
    const { bodyResetMs, headerRetryMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
    const retryMs = bodyResetMs(bodyText);
    // 冻结：传 retryMs 给 markQuotaExhausted（等价 reactToFailure effect 路径）
    p.markQuotaExhausted(acc, headerRetryMs({}) || retryMs);
    check('A3/A4 冻结恢复点 = body 的精确 ISO（≈now+2h 非 +5h 默认），状态 frozen + limit.window',
      acc.nextResetAt > Date.now() + 1.8 * 3600 * 1000 && acc.nextResetAt < Date.now() + 2.2 * 3600 * 1000
      && acc.status === 'frozen' && !!acc.limit && acc.limit.kind === 'window', String(acc.nextResetAt));
    // 等 A 组补探测定时器完成再清理（防跨组定时器交错污染计数）
    await new Promise((r) => setTimeout(r, 450));
    billingHits = 0;
  }

  // --- 修复 B：冻结后自动补探测刷新 quota ---
  console.log('== 修复 B：429/400 冻结后 _probeAfterResponseFreeze 自动补探测（quota 不再 stale）==');
  {
    const { p, inst, acc } = await addAcc(await mkProvider('pb'), 'sk-freeze-b');
    const hitsBefore = billingHits;
    // 冻结（走 markQuotaExhausted 覆写 -> 触发 _probeAfterResponseFreeze 的 300ms 定时补探测）
    p.markQuotaExhausted(acc, 5 * 3600 * 1000);
    // 等 300ms 定时补探测完成（其效果由 B2/B3 断言，此处不设恒真标记）
    await new Promise((r) => setTimeout(r, 800));
    // 补探测应命中 billing server（detectInstanceQuota 直连 mock）
    check('B2 补探测已访问 billing server（冻结后 quota 不再 stale）', billingHits > hitsBefore, 'hits ' + hitsBefore + '→' + billingHits);
    // quota 应刷新为真实超限（fiveHour exceeded -> percent 100 / rate-limited），且恢复点收敛到 billing resetAt
    const rl = (acc.quota || inst.quota || {}).rolling;
    check('B3/B4 补探测后 rolling = 100%/rate-limited，nextResetAt 收敛到 billing 的 resetAt（官方精确）',
      !!rl && rl.status === 'rate-limited' && rl.percent === 100
      && Math.abs(acc.nextResetAt - new Date(billingState.fiveHour.resetAt).getTime()) < 2000,
      JSON.stringify(rl) + ' nextResetAt=' + acc.nextResetAt);
    // 等 B 组残留定时器全部排空（B 的 mark 排了定时器 + reconcileNow 异步）
    await new Promise((r) => setTimeout(r, 450));
    billingHits = 0;
  }

  // --- 修复 B 自愈：billing 显示未超限 -> 冻结误判自动解冻 ---
  console.log('== 修复 B 自愈：补探测发现未超限 → applyDetection 自动解冻 ==');
  {
    const { p, acc } = await addAcc(await mkProvider('pc'), 'sk-freeze-c');
    // 先制造一次真实超限冻结，再让 billing 变健康
    billingState = { limited: false, exceeded: null, fiveHour: { used: 0.5, cap: 3, exceeded: false, resetAt: new Date(Date.now() + 3600 * 1000).toISOString() }, weekly: { used: 1, cap: 6, exceeded: false, resetAt: null } };
    // 冻结后 300ms 补探测会读到「健康」billing -> applyDetection 解冻回 ready
    const hitsC = billingHits;
    p.markQuotaExhausted(acc, 5 * 3600 * 1000);
    // 轮询等待补探测完成（最多 3s）：避免固定 800ms 与跨组定时器竞态
    for (let w = 0; w < 30 && billingHits === hitsC; w++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300)); // 让 applyDetection 落定
    check('C1/C2/C3 billing 恢复健康 → 补探测自动解冻 ready、limit 清空、quota 刷新为健康（rolling 未满）',
      acc.status === 'ready' && !acc.limit && !!(acc.quota && acc.quota.rolling) && acc.quota.rolling.status === 'ok',
      'status=' + acc.status + ' limit=' + JSON.stringify(acc.limit));
  }

  // --- D：commandcode-billing 上游报文契约（复用本文件真 http mock）---
  //   只留有独立风险的上游兼容判据：100%-无-exceeded 不矛盾 / data 信封 / 字符串 used·cap /
  //   currentPeriodEnd→monthlyResetAt / cancelAtPeriodEnd→null / 额度充足不取订阅（防风控）。
  console.log('== D：commandcode-billing 上游报文契约（credits 面 + 订阅面）==');
  {
    // D1 100% 周窗口、上游不返 exceeded -> 不得存出 status:ok + percent:100 的矛盾记录。
    creditsReply = () => ({
      windowLimits: { fiveHour: { cap: 2000, used: 200, resetAt: Date.now() + 3600000 }, weekly: { cap: 100, used: 100, resetAt: Date.now() + 604800000 } },
      credits: { monthlyCredits: 4, purchasedCredits: 0, freeCredits: 0 },
    });
    subReply = null;
    const d1 = await addAcc(await mkProvider('pd1'), 'sk-quota-d1');
    const r1 = await d1.p.detectInstanceQuota(d1.inst);
    check('D1 周 100% 无 exceeded → rate-limited（不再 status:ok 矛盾）',
      r1.ok && d1.inst.quota.weekly.status === 'rate-limited' && d1.inst.quota.weekly.percent === 100, JSON.stringify(d1.inst.quota.weekly));

    // D2 信封形态 { data: { windowLimits } }（上游把结果包在 data 里）
    creditsReply = () => ({ data: { windowLimits: { fiveHour: { cap: 10, used: 10, resetAt: null } }, credits: {} } });
    const d2 = await addAcc(await mkProvider('pd2'), 'sk-quota-d2');
    const r2 = await d2.p.detectInstanceQuota(d2.inst);
    check('D2 data 信封解包 → 5h 100% rate-limited',
      r2.ok && d2.inst.quota.rolling.status === 'rate-limited' && d2.inst.quota.rolling.percent === 100, JSON.stringify(d2.inst.quota.rolling));

    // D3 used/cap 为字符串（上游兼容形态）
    creditsReply = () => ({ windowLimits: { fiveHour: { cap: '2000', used: '300', resetAt: Date.now() + 3600000 }, weekly: { cap: '100', used: '50', resetAt: null } } });
    const d3 = await addAcc(await mkProvider('pd3'), 'sk-quota-d3');
    const r3 = await d3.p.detectInstanceQuota(d3.inst);
    check('D3 字符串 used/cap 解析 → 5h 15% ok',
      r3.ok && d3.inst.quota.rolling.percent === 15 && d3.inst.quota.rolling.status === 'ok', JSON.stringify(d3.inst.quota.rolling));

    // D4 credits-limited 账号取订阅：currentPeriodEnd -> monthlyResetAt 精确恢复点
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

    // D5 cancelAtPeriodEnd（订阅不可靠）-> 不赌续订，回退轮询
    subReply = { success: true, data: { status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() + 25 * 24 * 3600 * 1000).toISOString() } };
    const d5 = await addAcc(await mkProvider('pd5'), 'sk-quota-d5');
    const r5 = await d5.p.detectInstanceQuota(d5.inst);
    check('D5 cancelAtPeriodEnd → monthlyResetAt=null（回退轮询，不赌续订）',
      r5.ok && d5.inst.quota.monthlyResetAt === null, JSON.stringify(d5.inst.quota.monthlyResetAt));

    // D6 额度充足 -> 不取订阅（零额外 API，防风控；唯一有运维代价的一条）
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

    // 复位默认应答（D 组在末尾，仍显式复位，避免后续追加场景被残留场景污染）
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
