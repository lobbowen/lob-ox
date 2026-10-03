#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const { pickAccount } = require(path.join(ROOT, 'src', 'domains', 'router', 'policies', 'switch'));
const { decideFailure, headerRetryMs, bodyResetMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'policies', 'failure'));

{
  const state = { accounts: [{ keyId: 'k1', usable: true }, { keyId: 'k2', usable: false }], kind: 'direct', cursor: 0 };
  const d = pickAccount(state, {});
  check('S1 轮换选中首个可用账号且 nextCursor 递增',
    d.keyId === 'k1' && d.reason === 'rotate' && d.nextCursor === 1, JSON.stringify(d));
  check('S1 无可用账号 → keyId=null；excludeKeys 强制排除 → 同样 null',
    pickAccount({ accounts: [{ keyId: 'k1', usable: false }], cursor: 0 }, {}).keyId === null
    && pickAccount({ accounts: [{ key: 'a', keyId: 'k1', usable: true }], cursor: 0 }, { excludeKeys: new Set(['a']) }).keyId === null,
    '');

  const sel = pickAccount({ accounts: [{ keyId: 'k1', usable: true }], selectedAccountKeyId: 'k1', cursor: 5 }, {});
  check('S1 锁定可用 → selected 且 cursor 不动', sel.keyId === 'k1' && sel.reason === 'selected' && sel.nextCursor === 5, JSON.stringify(sel));

  const sticky = pickAccount({ accounts: [{ keyId: 'k1', usable: true }], activeAccountKeyId: 'k1', cursor: 5 }, {});
  check('S1 无锁但 active 可用 → 粘滞', sticky.keyId === 'k1' && sticky.reason === 'sticky', JSON.stringify(sticky));

  const dead = pickAccount({ accounts: [{ keyId: 'k1', status: 'banned', usable: false }, { keyId: 'k2', usable: true }], selectedAccountKeyId: 'k1', cursor: 0 }, {});
  const frozen = pickAccount({ accounts: [{ keyId: 'k1', status: 'frozen', usable: false }, { keyId: 'k2', usable: true }], selectedAccountKeyId: 'k1', cursor: 0 }, {});
  check('S1 锁定账号 banned 才清锁换号；frozen 临时冻结不清锁但同样落到可用号',
    dead.clearSelected === true && dead.keyId === 'k2' && frozen.clearSelected === false && frozen.keyId === 'k2',
    JSON.stringify([dead, frozen]));

  const proxy = pickAccount({ accounts: [{ keyId: 'k1', usable: true, running: false }, { keyId: 'k2', usable: true, running: true }], instancePool: true, cursor: 0 }, {});
  const proxyFallback = pickAccount({ accounts: [{ keyId: 'k1', usable: true, running: false }], instancePool: true, cursor: 0 }, {});
  check('S1 反代就绪优先选实例已运行账号；无就绪账号时降级全可用池',
    proxy.keyId === 'k2' && proxyFallback.keyId === 'k1', JSON.stringify([proxy, proxyFallback]));
}

{
  const credits = decideFailure('credits', { status: 400, key: '...k9' });
  const banned = decideFailure('banned', { status: 403, key: '...k9' });
  check('S2 credits → retry + needEffect；banned → passthrough + needEffect',
    credits.action === 'retry' && credits.needEffect === true
    && banned.action === 'passthrough' && banned.needEffect === true, JSON.stringify([credits, banned]));

  const win = decideFailure('window', { status: 429, headers: { 'retry-after': '60' }, key: '...k9' });
  const winBody = decideFailure('window', { status: 429, body: 'resets in 5 min', key: 'k' });
  const winNone = decideFailure('window', { status: 429, key: 'k' });
  check('S2 window retryMs：Retry-After=60 → 60000、body "resets in 5 min" → 300000、都取不到 → 0（上层走默认）',
    win.action === 'retry' && win.retryMs === 60000 && winBody.retryMs === 300000 && winNone.retryMs === 0,
    JSON.stringify([win, winBody, winNone]));

  const tr = decideFailure('transient', { status: 503, key: 'k' });
  check('S2 transient → retry + transient 且不施加 effect', tr.action === 'retry' && tr.transient === true && tr.needEffect === false, JSON.stringify(tr));

  const none = decideFailure('none', { status: 400, body: 'x', key: 'k' });
  const unknown = decideFailure('whatever', { status: 500, key: 'k' });
  check('S2 none（绝不误切）与未知档 → passthrough 且不施加 effect',
    none.action === 'passthrough' && none.needEffect === false && unknown.action === 'passthrough',
    JSON.stringify([none, unknown]));
}

{
  // H-04：原先这段是「为双实现而生的对账测试」——它只证两份实现彼此一致，
  // 却不钉住任何一方的行为（两份同时漂移它也绿）。双实现已合并（providers 转调生产单源），
  // 对账对象随之作废 ⇒ 改成直接钉生产实现的判据（秒 / HTTP-date / epoch / 相对时长 / 取不到）。
  const httpDate = new Date(Date.now() + 90 * 1000).toUTCString();
  check('S2-A headerRetryMs：秒数 → 毫秒；HTTP-date → 到该时刻的剩余 ms；空 → 0',
    headerRetryMs({ 'retry-after': '120' }) === 120000
    && headerRetryMs({ 'retry-after': httpDate }) > 80000 && headerRetryMs({ 'retry-after': httpDate }) < 100000
    && headerRetryMs({}) === 0,
    String(headerRetryMs({ 'retry-after': '120' })) + '/' + String(headerRetryMs({ 'retry-after': httpDate })));
  const epMs = headerRetryMs({ 'x-ratelimit-reset-ms': String(Date.now() + 5000) });
  check('S2-B headerRetryMs：x-ratelimit-reset-ms（绝对 epoch 毫秒）→ 剩余 ms 且不久于 5s',
    epMs > 0 && epMs <= 5000, String(epMs));
  const iso = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const isoMs = bodyResetMs('resets at ' + iso);
  check('S2-C bodyResetMs："resets at <ISO>" → 精确到绝对时刻（≈+2h，非默认 +5h）',
    isoMs > 1.8 * 3600 * 1000 && isoMs < 2.2 * 3600 * 1000, String(isoMs));
  check('S2-D bodyResetMs：相对时长 min / sec → 300000 / 30000；无时间信息 → 0',
    bodyResetMs('resets in 5 min') === 300000 && bodyResetMs('retry in 30 sec') === 30000
    && bodyResetMs('no time info') === 0,
    String(bodyResetMs('resets in 5 min')) + '/' + String(bodyResetMs('retry in 30 sec')));
  // 单源证据：providers 侧不再自带一份，而是转调生产（同一函数对象）
  const base = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  check('S2-E 单源：providers/base 转出的 headerRetryMs / bodyResetMs 与生产**同一函数对象**（不再各存一份）',
    base.headerRetryMs === headerRetryMs && base.bodyResetMs === bodyResetMs,
    'header=' + (base.headerRetryMs === headerRetryMs) + ' body=' + (base.bodyResetMs === bodyResetMs));
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
