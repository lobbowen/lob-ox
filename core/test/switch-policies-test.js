#!/usr/bin/env node
'use strict';

// router 纯策略单测：只 require policies/switch 与 policies/failure，给假 state/ctx，零 IO。
//   覆盖选号序列（selected/sticky/rotate/clearSelected/excludeKeys/反代就绪优先）
//   与失败动作映射（credits/window/banned/transient/none + retryMs 阈值）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

const { pickAccount } = require(path.join(ROOT, 'src', 'domains', 'router', 'policies', 'switch'));
const { decideFailure, headerRetryMs, bodyResetMs } = require(path.join(ROOT, 'src', 'domains', 'router', 'policies', 'failure'));

// -- S1 选号策略 --
{
  const state = { accounts: [{ keyId: 'k1', usable: true }, { keyId: 'k2', usable: false }], kind: 'direct', cursor: 0 };
  const d = pickAccount(state, {});
  // 同一次 pickAccount 的两个侧面：选谁 + 游标走没走。
  check('S1 轮换选中首个可用账号且 nextCursor 递增',
    d.keyId === 'k1' && d.reason === 'rotate' && d.nextCursor === 1, JSON.stringify(d));
  // 两个「选不出」的输入（无可用账号 / excludeKeys 强制排除）同一判据（keyId=null）。
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
  // 正反对照成对出现：banned 才清锁、frozen（临时冻结）不清锁。
  check('S1 锁定账号 banned 才清锁换号；frozen 临时冻结不清锁但同样落到可用号',
    dead.clearSelected === true && dead.keyId === 'k2' && frozen.clearSelected === false && frozen.keyId === 'k2',
    JSON.stringify([dead, frozen]));

  const proxy = pickAccount({ accounts: [{ keyId: 'k1', usable: true, running: false }, { keyId: 'k2', usable: true, running: true }], instancePool: true, cursor: 0 }, {});
  const proxyFallback = pickAccount({ accounts: [{ keyId: 'k1', usable: true, running: false }], instancePool: true, cursor: 0 }, {});
  check('S1 反代就绪优先选实例已运行账号；无就绪账号时降级全可用池',
    proxy.keyId === 'k2' && proxyFallback.keyId === 'k1', JSON.stringify([proxy, proxyFallback]));
}

// -- S2 失败反应策略：动作映射 + retryMs --
{
  const credits = decideFailure('credits', { status: 400, key: '...k9' });
  const banned = decideFailure('banned', { status: 403, key: '...k9' });
  // credits 换号（retry）与 banned 封号（passthrough）是两个后果不同的分支，但同一「必须施加 effect」判据。
  check('S2 credits → retry + needEffect；banned → passthrough + needEffect',
    credits.action === 'retry' && credits.needEffect === true
    && banned.action === 'passthrough' && banned.needEffect === true, JSON.stringify([credits, banned]));

  const win = decideFailure('window', { status: 429, headers: { 'retry-after': '60' }, key: '...k9' });
  const winBody = decideFailure('window', { status: 429, body: 'resets in 5 min', key: 'k' });
  const winNone = decideFailure('window', { status: 429, key: 'k' });
  // retryMs 的三个输入（header / body / 都没有）属同一判据，并成一条。
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

// -- retry 时长解析与 providers/base 逐字对齐（防两处漂移）--
{
  const base = require(path.join(ROOT, 'src', 'domains', 'router', 'providers', 'base'));
  // 绝对时刻样本两侧各自调用 Date.now()，毫秒级抖动会偶发假红；
  // 容差 50ms 远小于任何语义差异（样本间隔为秒/小时级），不掩盖真实漂移。
  const sameMs = (x, y) => (x === y) ||
    (typeof x === 'number' && typeof y === 'number' && Math.abs(x - y) <= 50);
  // 一致性对照样本 9 → 3：数字样本、时长措辞样本、无时间信息边界各一条。
  const h = { 'retry-after': '120' };
  check('S2 headerRetryMs 与 providers/base 一致（数字样本）',
    sameMs(headerRetryMs(h), base.headerRetryMs(h)), String(headerRetryMs(h)));
  for (const b of ['resets in 5 min', 'no time info']) {
    check('S2 bodyResetMs 与 base 一致 ' + JSON.stringify(b), sameMs(bodyResetMs(b), base.bodyResetMs(b)), b);
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
