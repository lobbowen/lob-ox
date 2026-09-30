'use strict';

// 月额度冻结/解冻语义测试：
//  信号 = 权威：上游 400 insufficient credits -> 冻结（月额度限额）——一步到位，无需阈值猜测；
//  解冻 = 只认正向证据：periodEnd 到期 或 余额较冻结时刻回升（充值）。
//  billing 面快照（percent 99/remaining>0）只刷新展示，【不得】推翻信号冻结——
//  修复前：冻结 300ms 后被补探测快照解冻 -> 99% 账号 frozen/ready 秒级死循环（生产实测 1 分钟 4 轮）。
// 用法: node test/monthly-credits-freeze-test.js

const { ProviderBase } = require('../src/domains/router/providers/base');

class TestProvider extends ProviderBase {
  constructor() {
    super({ id: 't', name: 'T', kind: 'proxy' });
    this.instanceOf = () => null;
  }
  async detectAccount() { return { ok: true, quota: null }; }
}

async function main() {
  const p = new TestProvider();
  const acc = {
    key: 'k-test', keyId: 'key-882aae8a-r3t4', maskedKey: '...r3t4', status: 'ready',
    quota: {
      rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 65 }, monthly: { status: 'ok', percent: 99 },
      monthlyRemaining: 0.067054828,
      credits: { monthlyCredits: 0.067054828, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
    },
  };
  p.accounts.push(acc);

  let pass = 0, fail = 0;
  const check = (n, c, x) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + ' ← ' + (x || '')); } };

  // 场景 A：请求 400 insufficient credits -> 冻结 + 基线
  p.markCreditsExhausted(acc);
  check('上游 credits 信号 → 冻结', acc.status === 'frozen' && acc.limit && acc.limit.kind === 'credits', acc.status);
  check('冻结记录余额基线（creditsAt）', typeof acc.limit.creditsAt === 'number' && Math.abs(acc.limit.creditsAt - 0.067054828) < 1e-9, String(acc.limit.creditsAt));

  // 场景 B：补探测返回同样的 99% 快照（月额度无实质变化）-> 维持冻结（含连续 5 拍采样）
  p.applyDetection(acc, { ok: true, quota: JSON.parse(JSON.stringify(acc.quota)) });
  for (let i = 0; i < 5; i++) p.applyDetection(acc, { ok: true, quota: JSON.parse(JSON.stringify(acc.quota)) });
  check('快照未变化 / 连续快照 → 维持冻结（修复前此处被解冻）', acc.status === 'frozen', acc.status);

  // 场景 C：余额回升（充值）-> 正向证据 -> 解冻
  const refilled = JSON.parse(JSON.stringify(acc.quota));
  refilled.monthlyRemaining = 5.0; refilled.credits.monthlyCredits = 5.0; refilled.monthly = { status: 'ok', percent: 50 };
  p.applyDetection(acc, { ok: true, quota: refilled });
  check('余额实质回升（充值）→ 解冻 ready', acc.status === 'ready', acc.status);

  // 场景 D：periodEnd 到期 + 月度重置 -> 正向证据 -> 解冻
  p.markCreditsExhausted(acc);
  acc.quota.monthlyResetAt = Date.now() + 1000;
  acc.limit.recovery = { type: 'at', at: acc.quota.monthlyResetAt };
  acc.nextResetAt = acc.quota.monthlyResetAt;
  await new Promise((r) => setTimeout(r, 1100));
  const reset = JSON.parse(JSON.stringify(acc.quota));
  reset.monthlyRemaining = 10.0; reset.credits.monthlyCredits = 10.0; reset.monthly = { status: 'ok', percent: 0 };
  p.applyDetection(acc, { ok: true, quota: reset });
  check('periodEnd 到期 + 余额重置 → 解冻 ready', acc.status === 'ready', acc.status);

  // 场景 E：旧数据兼容（无 creditsAt 基线的既有冻结）-> 只认证据 a)，无到期保持冻结
  const legacy = { key: 'k2', keyId: 'legacy', maskedKey: '...legacy', status: 'frozen', quota: { rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 65 }, monthly: { status: 'ok', percent: 99 }, monthlyRemaining: 0.05, credits: { monthlyCredits: 0.05, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 } } };
  p.accounts.push(legacy);
  legacy.limit = { kind: 'credits', since: Date.now(), reason: 'x', recovery: { type: 'poll', periodMs: 600000 } };
  legacy.nextResetAt = Date.now() + 3600e3;
  p.applyDetection(legacy, { ok: true, quota: JSON.parse(JSON.stringify(legacy.quota)) });
  check('无基线旧冻结 + 无到期 → 维持冻结（兼容）', legacy.status === 'frozen', legacy.status);

  // 场景 F：未进入灰区的正常账号不受影响
  const normal = { key: 'k3', keyId: 'normal', maskedKey: '...normal', status: 'ready', quota: { rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 65 }, monthly: { status: 'ok', percent: 60 }, monthlyRemaining: 3.99, credits: { monthlyCredits: 3.99, purchasedCredits: 0, freeCredits: 0, belowThreshold: false, creditThreshold: 0 } } };
  p.accounts.push(normal);
  p.applyDetection(normal, { ok: true, quota: JSON.parse(JSON.stringify(normal.quota)) });
  check('60% 正常账号不受影响', normal.status === 'ready', normal.status);

  // -- 场景 G：creditsRefilled 对 null 基线必须 fail-closed --
  //   冻结时无余额证据 -> freeze.js 记 lim.creditsAt = null。旧实现 Number(null)===0 是有限值，
  //   任意正余额都满足 now>0 -> 误判「已充值」解冻，耗尽账号被重新选路。
  const quota = require('../src/domains/router/providers/policies/quota');
  const mkFrozen = (creditsAt, remaining) => ({
    status: 'frozen', nextResetAt: Date.now() + 3600e3, // 未到期：证据 a) 不成立
    limit: { kind: 'credits', creditsAt },
    quota: { monthlyRemaining: remaining, credits: { monthlyCredits: remaining } },
  });
  check('G-B18 null/undefined 基线 + 任意正余额 → 不判「已充值」（fail-closed）',
    quota.creditsRefilled(mkFrozen(null, 9.99)) === false && quota.creditsRefilled(mkFrozen(undefined, 9.99)) === false, 'ok');
  // 反向（防空转）：数值基线且余额确实回升 -> 必须判 true（证明未写死 false）
  check('G-B18 反向：数值基线 5→10 回升 → 判「已充值」true',
    quota.creditsRefilled(mkFrozen(5, 10)) === true, 'ok');
  check('G-B18 反向：数值基线 5→3 未回升 → 判 false',
    quota.creditsRefilled(mkFrozen(5, 3)) === false, 'ok');

  // -- 场景 H：null 基线冻结账号收到正余额快照（无到期）-> applyDetection 维持冻结 --
  const noEv = { key: 'k4', keyId: 'no-ev', maskedKey: '...no-ev', status: 'ready',
    quota: { rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 0 }, monthly: { status: 'ok', percent: 0 } } }; // 无 monthlyRemaining/credits -> 冻结基线为 null
  p.accounts.push(noEv);
  p.markCreditsExhausted(noEv); // 触发 credits 冻结（此时无余额证据 -> creditsAt=null）
  check('H-B18 冻结基线为 null（无余额证据）', noEv.status === 'frozen' && noEv.limit.creditsAt === null, JSON.stringify(noEv.limit && noEv.limit.creditsAt));
  // 后续补探测带回正余额（percent 已回落不再 creditsLow），且无 periodEnd 到期 -> 不得解冻
  noEv.nextResetAt = Date.now() + 3600e3;
  if (noEv.limit.recovery) noEv.limit.recovery.at = noEv.nextResetAt;
  p.applyDetection(noEv, { ok: true, quota: { rolling: { status: 'ok', percent: 0 }, weekly: { status: 'ok', percent: 0 }, monthly: { status: 'ok', percent: 0 }, monthlyRemaining: 8.0, credits: { monthlyCredits: 8.0 } } });
  check('H-B18 null 基线 + 正余额快照 + 未到期 → 维持冻结（旧实现此处误解冻）', noEv.status === 'frozen', noEv.status);

  console.log('\n==============================');
  console.log('结果: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('monthly-credits-freeze test error:', e); process.exit(1); });
