#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { ProviderBase, classifyUpstreamLimited, isQuotaCreditsLow, quotaOverallStatus } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}

async function main() {
  console.log('== 上游限制分类 classifyUpstreamLimited ==');
  // 实据：Command /alpha/generate 原始错误体 400 + "You have insufficient credits"；代理层只对 5xx/429 重试 ⇒ 400 余额不足必须由路由层换号。
  check('真实样本：CC 400 success=false error.code=BAD_REQUEST → credits',
    classifyUpstreamLimited(400, '{"success":false,"error":{"code":"BAD_REQUEST","status":400,"message":"You have insufficient credits to make this request. Please purchase more credits to continue using the service.","docs":"https://commandcode.ai/docs/reference/errors/bad_request"}}') === 'credits');
  check('真实样本：commandcode-api-proxy 信封(CC API 400 内嵌原体) → credits',
    classifyUpstreamLimited(400, '{"error":{"message":"CC API 400: {\"success\":false,\"error\":{\"code\":\"BAD_REQUEST\",\"status\":400,\"message\":\"You have insufficient credits to make this request. Please purchase more credits.\"}}","type":"proxy_error"}}') === 'credits');
  check('400 无 credits 关键词 / 200 正常 → none（不误判为限额，两输入合 1 条）', classifyUpstreamLimited(400, '{"error":"context length exceeded"}') === 'none' && classifyUpstreamLimited(200, 'ok') === 'none');
  check('402 任意 → credits', classifyUpstreamLimited(402, 'payment required') === 'credits');
  check('429 quota 窗口词 → window', classifyUpstreamLimited(429, '{"error":{"message":"monthly limit exceeded"}}') === 'window');
  check('429 billing/credits 词优先 → credits', classifyUpstreamLimited(429, 'billing error: insufficient credits') === 'credits');
  check('401/403 无配额信息 → banned（封号语义，两状态合 1 条）', classifyUpstreamLimited(403, 'forbidden') === 'banned' && classifyUpstreamLimited(401, 'invalid api key') === 'banned');
  check('429 无词 → none（不误判为限额）', classifyUpstreamLimited(429, 'rate limited, retry later') === 'none');
  check('5xx 平台错 → transient（不冻结，503/500 合 1 条）', classifyUpstreamLimited(503, 'service unavailable') === 'transient' && classifyUpstreamLimited(500, 'internal error') === 'transient');

  console.log('== ProviderBase.markCreditsExhausted（冻结 + 周期重探）==');
  {
    let persisted = 0;
    const p = new ProviderBase({ id: 't', name: 'T', kind: 'direct', onPersist: () => { persisted += 1; } });
    const acc = { key: 'k1', keyId: 'k1', status: 'ready', maskedKey: '...k1', quota: { monthlyRemaining: 0 } };
    p.accounts.push(acc);
    p.markCreditsExhausted(acc);
    check('冻结生效：status=frozen 且不再可用（不可挑选）', acc.status === 'frozen' && p.isAccountUsable(acc) === false, acc.status);
    check('带周期重探 nextResetAt（区间：未到重置点且在 1 小时内）', acc.nextResetAt && acc.nextResetAt > Date.now() && acc.nextResetAt - Date.now() <= 60 * 60 * 1000, acc.nextResetAt ? acc.nextResetAt - Date.now() : null);
    check('credits 语义由 limit.kind 表达 + 统一额度用尽文案（不再靠文案 credits 字样）', !!(acc.limit && acc.limit.kind === 'credits') && typeof acc.detectError === 'string', JSON.stringify(acc.limit));
    check('触发持久化', persisted > 0, persisted);
  }

  console.log('== credits-low 在 isAccountUsable 中排除（检测到低余额即使 ready 也不选）==');
  {
    const p = new ProviderBase({ id: 't2', name: 'T2', kind: 'direct' });
    p._isCreditsLow = (a) => !!(a.quota && ((typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0) || (a.quota.credits && a.quota.credits.belowThreshold === true)));
    const acc = { key: 'k2', keyId: 'k2', status: 'ready', maskedKey: '...k2', quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 10 }, monthly: null, monthlyRemaining: 0, credits: { monthlyCredits: 0, belowThreshold: false } } };
    check('余额=0 → 不可用（真实采样：0 余额会被上游拒付）', p.isAccountUsable(acc) === false);
    acc.quota.monthlyRemaining = 5; acc.quota.credits = { monthlyCredits: 5, belowThreshold: false };
    check('充值后余额>0 → 恢复可用', p.isAccountUsable(acc) === true);
    acc.quota.credits = { monthlyCredits: 5, belowThreshold: true };
    check('belowThreshold=true（官方低余额提醒）→ 不可用', p.isAccountUsable(acc) === false);
  }

  console.log('== limit.kind：封号 → banned/manual（其余 kind 采样见上/下方 credits·window 面）==');
  {
    const p = new ProviderBase({ id: 't3', name: 'T3', kind: 'direct' });
    const ab = { key: 'kb', keyId: 'kb', status: 'ready', maskedKey: '...kb' };
    p.markBanned(ab, '401');
    check('markBanned → limit.kind=banned + recovery=manual', !!(ab.limit && ab.limit.kind === 'banned' && ab.limit.recovery && ab.limit.recovery.type === 'manual'), ab.limit);
  }
  {
    const p = new ProviderBase({ id: 't4', name: 'T4', kind: 'direct' });
    const acc = { key: 'kc', keyId: 'kc', status: 'frozen', maskedKey: '...kc', quota: { monthlyRemaining: 0 }, detectError: 'credits 余额不足（充值后自动恢复）', nextResetAt: Date.now() + 1000 };
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0);
    acc.quota.monthlyRemaining = 6;
    acc.status = 'frozen'; acc.limit = null; acc.nextResetAt = Date.now() - 1000;
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyRemaining: 6 } });
    check('余额恢复 → 解冻 ready 且 limit 清空', acc.status === 'ready' && (acc.limit === null || acc.limit === undefined), acc.status + ' limit=' + JSON.stringify(acc.limit));
    acc.status = 'ready'; acc.limit = null; acc.nextResetAt = null; acc.quota.monthlyRemaining = 0;
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyRemaining: 0 } });
    check('仍余额不足 → 保持 frozen 且 limit.kind=credits poll', acc.status === 'frozen' && acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery.type === 'poll', acc.status + ' ' + JSON.stringify(acc.limit));
  }
  {
    const p = new ProviderBase({ id: 't5', name: 'T5', kind: 'direct' });
    const acc = { key: 'kw', keyId: 'kw', status: 'frozen', maskedKey: '...kw', nextResetAt: Date.now() - 1000, quota: { monthly: { status: 'rate-limited', percent: 100, resetsAt: Date.now() + 3000 } } };
    p.applyDetection(acc, { ok: true, quota: acc.quota });
  }

  console.log('== 月度重置：quota.monthlyResetAt（订阅 currentPeriodEnd）→ recovery.at 定点调度 ==');
  {
    const p = new ProviderBase({ id: 't6', name: 'T6', kind: 'direct', onPersist: () => {} });
    const at = Date.now() + 20 * 24 * 3600 * 1000;
    const acc = { key: 'km', keyId: 'km', status: 'ready', maskedKey: '...km', quota: { monthlyCredits: 0, monthlyRemaining: 0, monthlyResetAt: at } };
    p.accounts.push(acc);
    p.markCreditsExhausted(acc);
    check('monthlyResetAt 已知 → limit.kind=credits + recovery.at 精确点 + nextResetAt=monthlyResetAt（不再 +10min 轮询，同一事件两面合 1 条）', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === at && acc.nextResetAt === at, JSON.stringify({ limit: acc.limit, next: acc.nextResetAt }));
  }
  {
    const p = new ProviderBase({ id: 't7', name: 'T7', kind: 'direct', onPersist: () => {} });
    const stale = Date.now() - 3600000; // 陈旧 periodEnd（已过期）不得当精确恢复点
    const acc = { key: 'ks', keyId: 'ks', status: 'frozen', maskedKey: '...ks', quota: { monthlyCredits: 0, monthlyRemaining: 0, monthlyResetAt: stale }, detectError: 'credits 余额不足（充值后自动恢复）', nextResetAt: Date.now() - 1000 };
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyRemaining: 0, monthlyResetAt: stale } });
    check('过期 monthlyResetAt → 回退 credits/poll（不赌不可靠恢复点）', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery && acc.limit.recovery.type === 'poll', acc.limit);
  }
  console.log('== reactToFailure：上游 ≥400 的分类与动作 ==');
  {
    const { SwitchEngine } = require(path.join(ROOT, 'src', 'domains', 'router', 'switch'));
    const se = new SwitchEngine({ logger: { info(){} } });
    const effects = [];
    const prov = {
      id: 'prov-x', name: 'ProviderX',
      classifyResponse: (status, headers, text) => classifyUpstreamLimited(status, text),
      effect: (sig, acc) => { effects.push(sig + ':' + acc.maskedKey); },
    };
    const acc = { maskedKey: '...k9' };
    const ccBody = '{"success":false,"error":{"code":"BAD_REQUEST","status":400,"message":"You have insufficient credits to make this request. Please purchase more credits to continue using the service."}}';
    const r1 = se.reactToFailure(prov, acc, { status: 400, headers: { 'Retry-After': '60' }, body: ccBody, attempt: 0, attempts: 3 });
    check('credits 400 → action=retry 且 effect 已执行', r1 && r1.action === 'retry' && r1.signal === 'credits' && effects.length === 1 && effects[0] === 'credits:...k9', JSON.stringify({ r1, effects }));
    const r2 = se.reactToFailure(prov, acc, { status: 503, body: 'service unavailable', attempt: 0, attempts: 3 });
    check('503 transient → retry + transient 标记', r2 && r2.action === 'retry' && r2.transient === true, JSON.stringify(r2));
    const r3 = se.reactToFailure(prov, acc, { status: 403, body: 'forbidden', attempt: 1, attempts: 3 });
    const r4 = se.reactToFailure(prov, acc, { status: 400, body: '{"error":"context length exceeded"}', attempt: 2, attempts: 3 });
    check('banned(403) / none(400) → 一律 passthrough 不误切（透传上游原体，两信号合 1 条）',
      r3 && r3.action === 'passthrough' && r3.signal === 'banned' && r4 && r4.action === 'passthrough' && r4.signal === 'none' && typeof r4.body === 'string',
      JSON.stringify({ r3, r4: r4 && { action: r4.action, signal: r4.signal } }));
  }

  console.log('== bodyResetMs/headerRetryMs：ISO 绝对重置时间解析 ==');
  {
    const { bodyResetMs, headerRetryMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
    const isoStr = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const cc429 = '{"error":{"message":"CC API 429: {\\"success\\":false,\\"error\\":{\\"code\\":\\"RATE_LIMITED\\",\\"status\\":429,\\"message\\":\\"You' + String.fromCharCode(39) + 've reached your 5-hour usage limit for your plan. Your limit resets at ' + isoStr + '. Please wait for the window to reset or upgrade your plan to continue.\\"}}}}';
    const isoMs = bodyResetMs(cc429);
    const expectMs = new Date(isoStr).getTime() - Date.now();
    check('bodyResetMs 解析 "resets at <ISO>" → 精确到绝对时刻的剩余 ms', isoMs > 0 && Math.abs(isoMs - expectMs) < 2000, isoMs + ' vs ' + expectMs);
    check('bodyResetMs 相对时长（min / sec 两种写法）→ 300000 / 30000', bodyResetMs('resets in 5 min') === 300000 && bodyResetMs('retry in 30 sec') === 30000, String(bodyResetMs('resets in 5 min')) + '/' + String(bodyResetMs('retry in 30 sec')));
    check('无时间信息 → 0（body 与 header 两入口同判，上层走默认 +5h）', bodyResetMs('some other error') === 0 && headerRetryMs({}) === 0, String(bodyResetMs('some other error')) + '/' + String(headerRetryMs({})));
    const httpDate = new Date(Date.now() + 90 * 1000).toUTCString();
    const hd = headerRetryMs({ 'retry-after': httpDate });
    check('headerRetryMs 支持秒数与 HTTP-date 两形态', headerRetryMs({ 'retry-after': '120' }) === 120000 && hd > 80000 && hd < 100000, String(headerRetryMs({ 'retry-after': '120' })) + '/' + String(hd));
  }

  console.log('== 新账号入库判定：检测后如实列示（2026-09 用户定稿）==');
  {
    const p = new ProviderBase({ id: 'ta', name: 'TA', kind: 'direct' });
    p._isCreditsLow = (a) => !!(a.quota && (typeof a.quota.monthlyCredits === 'number' && a.quota.monthlyCredits <= 0));
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 10 }, monthlyCredits: 0, credits: { monthlyCredits: 0, belowThreshold: false } } });
    const r = await p.addAccount('nk-credits0');
    check('月额度用尽新账号：检测后入库为 frozen（不再 ready/review/discard）', r.ok && r.account && r.account.status === 'frozen', JSON.stringify(r && r.account && r.account.status));
    check('返回 limited=credits/review=false + limit.kind=credits poll（无订阅期 → 轮询兜底，同一入库事件两面合 1 条）', r.limited === 'credits' && r.review === false && r.account.limit && r.account.limit.kind === 'credits' && r.account.limit.recovery && r.account.limit.recovery.type === 'poll', JSON.stringify({ limited: r.limited, review: r.review, limit: r.account.limit }));
  }
  {
    const p = new ProviderBase({ id: 'tb', name: 'TB', kind: 'direct' });
    const at = Date.now() + 25 * 24 * 3600 * 1000;
    p._isCreditsLow = (a) => !!(a.quota && (typeof a.quota.monthlyCredits === 'number' && a.quota.monthlyCredits <= 0));
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 5 }, weekly: { status: 'ok', percent: 5 }, monthlyCredits: 0, monthlyResetAt: at, credits: { monthlyCredits: 0, belowThreshold: false } } });
    const r = await p.addAccount('nk-credits-at');
    check('detectError 含预计重置时间', String(r.account.detectError).includes('自动恢复'), r.account.detectError);
  }
  {
    const p = new ProviderBase({ id: 'tc', name: 'TC', kind: 'direct' });
    const weeklyResetAt = Date.now() + 3600000;
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 30 }, weekly: { status: 'rate-limited', percent: 100, resetsAt: weeklyResetAt }, monthly: null } });
    const r = await p.addAccount('nk-windowfull');
    check('窗口满新账号：直接 frozen（不再 review 闸门）+ limit.kind=window + recovery.at=周窗口 resetsAt（到点自动解冻，同一入库事件两面合 1 条）',
      r.ok && r.account.status === 'frozen' && r.limited === 'window' && r.review === false && r.account.limit && r.account.limit.kind === 'window' && r.account.limit.recovery && r.account.limit.recovery.type === 'at' && r.account.limit.recovery.at === weeklyResetAt && r.account.nextResetAt === weeklyResetAt,
      JSON.stringify({ status: r.account && r.account.status, limited: r.limited, limit: r.account.limit }));
  }
  {
    const p = new ProviderBase({ id: 'tc2', name: 'TC2', kind: 'direct' });
    const weeklyResetAt = Date.now() + 7200000;
    const acc = { key: 'kw2', keyId: 'kw2', status: 'ready', maskedKey: '...kw2', quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 90 }, monthly: null } };
    p.accounts.push(acc);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'rate-limited', percent: 100, resetsAt: weeklyResetAt }, monthly: null } });
    check('运行中窗口满（探测判定）：frozen + window/at 与添加时同一处置', acc.status === 'frozen' && acc.limit && acc.limit.kind === 'window' && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === weeklyResetAt, JSON.stringify(acc.limit));
  }
  {
    const p = new ProviderBase({ id: 'td', name: 'TD', kind: 'direct' });
    p.detectAccount = async () => ({ ok: true, quota: { rolling: { status: 'ok', percent: 30 }, weekly: { status: 'ok', percent: 40 }, monthly: null } });
    const r = await p.addAccount('nk-ready');
    check('额度正常新账号 → ready 直接入池', r.ok && r.review === false && r.account.status === 'ready', JSON.stringify(r.account && r.account.status));
  }

  console.log('== 配额总览标签/credits 判定单源（2026-09 债务清理：修复 proxy/index 两处实现分叉）==');
  {
    check('credits0+周满 / 周+5h 同满（无月窗口）/ 月窗口满 → 一律「用尽」（credits 优先；视图与检测同源）',
      quotaOverallStatus({ rolling: { status: 'ok', percent: 10 }, weekly: { status: 'rate-limited', percent: 100 }, monthly: null, monthlyCredits: 0, monthlyRemaining: 0, credits: { monthlyCredits: 0, belowThreshold: false } }) === '额度用尽'
      && quotaOverallStatus({ rolling: { status: 'rate-limited', percent: 100 }, weekly: { status: 'rate-limited', percent: 100 }, monthly: null }) === '用尽'
      && quotaOverallStatus({ rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 20 }, monthly: { status: 'rate-limited', percent: 100 } }) === '用尽');
    check('仅周满 → 周限额 / 仅 5h 满 → 5h限额 / 正常与 null → 正常',
      quotaOverallStatus({ rolling: { status: 'ok', percent: 30 }, weekly: { status: 'rate-limited', percent: 100 }, monthly: null }) === '周限额'
      && quotaOverallStatus({ rolling: { status: 'rate-limited', percent: 100 }, weekly: { status: 'ok', percent: 30 }, monthly: null }) === '5h限额'
      && quotaOverallStatus({ rolling: { status: 'ok', percent: 10 }, weekly: { status: 'ok', percent: 20 }, monthly: null }) === '正常'
      && quotaOverallStatus(null) === '正常');
    check('isQuotaCreditsLow：mr=0 true / belowThreshold true / 无 credits 信息 false', isQuotaCreditsLow({ monthlyRemaining: 0 }) === true && isQuotaCreditsLow({ credits: { monthlyCredits: 5, belowThreshold: true } }) === true && isQuotaCreditsLow({ weekly: { status: 'ok', percent: 10 } }) === false && isQuotaCreditsLow(null) === false);
  }

  console.log('== applyDetection 收敛修复（2026-09 二次）：过期 nextResetAt 采纳新精确值 / credits at 不降级）==');
  {
    const p = new ProviderBase({ id: 'tb1', name: 'TB1', kind: 'direct' });
    const realReset = Date.now() + 6 * 24 * 3600 * 1000;
    const acc = { key: 'kw-stale', keyId: 'kw-stale', status: 'frozen', maskedKey: '...kw-stale', quota: { rolling: { status: 'ok', percent: 10 }, weekly: { status: 'rate-limited', percent: 100, resetsAt: realReset }, monthly: null }, nextResetAt: Date.now() - 2 * 3600 * 1000, limit: { kind: 'window', since: Date.now() - 86400000, recovery: { type: 'at', at: Date.now() - 2 * 3600 * 1000 } } };
    p.applyDetection(acc, { ok: true, quota: acc.quota });
    check('过期 nextResetAt → 采纳真实 resetsAt（不再卡死）', acc.nextResetAt === realReset && acc.limit.recovery.at === realReset, JSON.stringify({ next: acc.nextResetAt, limitAt: acc.limit.recovery.at }));
  }
  {
    const p = new ProviderBase({ id: 'tb2', name: 'TB2', kind: 'direct' });
    const at = Date.now() + 20 * 24 * 3600 * 1000;
    const acc = { key: 'kc-at', keyId: 'kc-at', status: 'frozen', maskedKey: '...kc-at', quota: { monthlyCredits: 0, monthlyRemaining: 0 }, detectError: 'credits 余额不足', nextResetAt: at, limit: { kind: 'credits', since: Date.now() - 1000, recovery: { type: 'at', at } } };
    p._isCreditsLow = (a) => !!(a.quota && typeof a.quota.monthlyRemaining === 'number' && a.quota.monthlyRemaining <= 0);
    p.applyDetection(acc, { ok: true, quota: { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthlyCredits: 0, monthlyRemaining: 0 } });
    check('探测缺失 monthlyResetAt → 保留既有 recovery.at（不降级 poll）', acc.limit && acc.limit.kind === 'credits' && acc.limit.recovery.type === 'at' && acc.limit.recovery.at === at, JSON.stringify(acc.limit));
  }

  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
