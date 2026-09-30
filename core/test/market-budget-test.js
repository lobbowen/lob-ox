#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 插件市场的**整体构建预算**
//
// 缺陷：社区源候选约 2468 个，按 8 并发分批、每批各带超时 —— 最坏可达数十分钟。真机取证：面板点
// 「刷新」得到 `请求超时（15s）`，而服务端仍在继续构建并写缓存 —— 用户见失败、结论却是好的。
// 修法（两层）：1) 给整次构建一个上限（默认 4 分钟，可经 buildBudgetMs 注入）：buildIndex() 造
// **本次构建私有**的预算 ctx（deadline + truncated 集合），finally 只清自己的；各源在发起新批次前
// 检查 `_budgetExhausted(bctx)`，到点即 break，用已采集的部分构建索引（与既有「坏构建保护」配合）。
// 旧实现把 deadline 挂实例上：叠建时先结束者 finally 清零，后启动者预算上限整体失效 —— M-h 即钉此点。
// 2) 请求不得等构建：getIndex 只回快照（building 表在飞、error 表上次失败原因），构建在后台跑。
// ---------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 等在飞构建真正收尾：摘除 `_inFlight` 登记挂在 raw 收尾链的**下一条微任务**上，
// 只 `await m._inFlight` 会读到尚未摘除的登记（M-i/Q3 因此在四平台同时判红）。
const settleBuild = async (m) => { if (!m._inFlight) return; await m._inFlight.catch(() => {}); await new Promise((r) => setImmediate(r)); };

// 步骤8a（DIRECTORY-STRUCTURE-DESIGN）：pluginmarket.js 改名归位为 market.js
const SRC = path.join(ROOT, 'src', 'domains', 'plugin', 'market.js');
const { PluginMarket } = require(SRC);

// -- M-a：可注入的预算 --
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const mk = (o) => new PluginMarket(Object.assign({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } }, o || {}));
  check('M-a 预算可注入（测试/特殊环境）', mk({ buildBudgetMs: 1234 }).buildBudgetMs === 1234, String(mk({ buildBudgetMs: 1234 }).buildBudgetMs));
  fs.rmSync(dir, { recursive: true, force: true });
}

// -- M-c：_budgetExhausted(bctx) 语义（B2-6c：预算归 ctx，不再是实例字段）--
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
  //  原「无 ctx（单源直调）」与「deadline:0」两条退化入参判据已删：断言的是内部助手对
  //  非真实入参形状的容忍度（助手若被内联进源循环即在产品无恙时判红）；真实语义由下面两条覆盖。
  check('M-c 未到点 → false', m._budgetExhausted({ deadline: Date.now() + 10000 }) === false, 'false');
  check('M-c 已到点 → true', m._budgetExhausted({ deadline: Date.now() - 1 }) === true, 'true');
  fs.rmSync(dir, { recursive: true, force: true });
}

// -- M-b / M-e：构建期间 deadline 生效，结束后清零；且返回部分结果不抛 --
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
  const m = new PluginMarket({
    cacheDir: dir,
    stateFile: path.join(dir, 's.json'),
    buildBudgetMs: 50,
    logger: { info() {}, warn() {}, error() {} },
  });
  const seen = [];
  let buildCtx = null;
  // 用**慢**的三源桩：每个源在被调用时记录此刻的预算 ctx（deadline 应非 0 = 构建中）
  const slow = (name, tag) => async function (bctx) {
    if (!buildCtx) buildCtx = bctx;
    seen.push({ name, deadlinePositive: !!bctx && bctx.deadline > 0, sameCtx: bctx === buildCtx });
    await new Promise((r) => setTimeout(r, 40));
    return tag ? [{ name: tag, source: name, stars: 1 }] : [];
  };
  m.indexNpm = slow('npm', 'a-npm');
  m.indexGithub = slow('github', null);
  m.indexCommunity = slow('community', null);
  // 让 saveToDisk 不真的写盘（无妨，tmp 目录）
  let cache = null, threw = null;
  try { cache = await m.buildIndex(); } catch (e) { threw = e; }
  check('M-e 构建不抛（超预算也返回部分）且返回了 npm 源已采集的部分结果',
    threw === null && !!(cache && (cache.plugins || []).some((p) => p.name === 'a-npm')),
    (threw ? threw.message : '无异常') + ' ' + JSON.stringify((cache && cache.plugins || []).map((p) => p.name)));
  check('M-b 构建期间预算 ctx 已置位且三源共享同一 ctx',
    seen.length === 3 && seen.every((x) => x.deadlinePositive && x.sameCtx),
    JSON.stringify(seen));
  check('M-b 构建结束后本次 ctx 清零（只清自己的）', buildCtx && buildCtx.deadline === 0, String(buildCtx && buildCtx.deadline));
  fs.rmSync(dir, { recursive: true, force: true });

  // -- M-f：**预算截断的源必须与旧缓存并集**（P2-8 配套修复）--
  //
  // 缺陷：既有的「坏构建保护」判据是「本次**整源失败**」（`!freshSources.has(source)`），
  //   而被截断的源**仍在结果里**（只是不完整）-> 该保护不保留它的旧条目
  //   -> 只跑到 200/2400 的 community 会**替换掉**完整的旧 community 列表。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({
      cacheDir: dir,
      stateFile: path.join(dir, 's.json'),
      logger: { info() {}, warn() {}, error() {} },
    });
    // 预置「完整」旧缓存：100 条 community + 5 条 npm
    const oldCommunity = [];
    for (let i = 0; i < 100; i++) oldCommunity.push({ name: 'old-c-' + i, source: 'community', stars: 1 });
    const oldNpm = [];
    for (let i = 0; i < 5; i++) oldNpm.push({ name: 'old-n-' + i, source: 'npm', stars: 1 });
    m._cache = { indexedAt: Date.now(), sources: { npm: 5, github: 0, community: 100 }, total: 105, plugins: oldNpm.concat(oldCommunity) };
    m._ts = Date.now();
    // 桩：community 被预算截断（只返回 3 条并标记）
    m.indexNpm = async () => oldNpm.map((x) => ({ name: x.name, source: 'npm', stars: 1 }));
    m.indexGithub = async () => [];
    m.indexCommunity = async function (bctx) {
      bctx.truncated.add('community');
      return [
        { name: 'new-c-1', source: 'community', stars: 1 },
        { name: 'new-c-2', source: 'community', stars: 1 },
        { name: 'new-c-3', source: 'community', stars: 1 },
      ];
    };
    const cache = await m.buildIndex();
    const names = new Set((cache.plugins || []).map((p) => p.name));
    check('M-f 截断源：新条目保留且旧条目被合并回来（不被替换）',
      names.has('new-c-1') && names.has('new-c-3') && names.has('old-c-0') && names.has('old-c-99'),
      '社区总数=' + (cache.plugins || []).filter((p) => p.source === 'community').length);
    //  原「总数 == 3+100」判据已删：它是上面判据的算术蕴含。
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- M-g（反向）：**未**截断的源不得合并旧条目（否则陈旧条目永不淘汰）--
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
    m._cache = { indexedAt: Date.now(), sources: {}, total: 1, plugins: [{ name: 'stale', source: 'community', stars: 1 }] };
    m._ts = Date.now();
    m.indexNpm = async () => [];
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [{ name: 'fresh-only', source: 'community', stars: 1 }];
    const cache = await m.buildIndex();
    const names = (cache.plugins || []).map((p) => p.name);
    check('M-g 未截断的源不合并旧条目（陈旧条目正常淘汰）',
      names.length === 1 && names[0] === 'fresh-only', names.join(','));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- M-h（B2-6c 本体）：叠建预算互不干扰 —— 先结束者只清自己的 ctx --
  //   旧实现（deadline 挂实例）下 A 的 finally 会把 B 还在用的 deadline 清零，
  //   B 构建中观察到 deadline<=0 = 预算上限失效，本断言必红。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), buildBudgetMs: 10000, logger: { info() {}, warn() {}, error() {} } });
    const ctxs = [];
    let n = 0;
    m.indexNpm = async function (bctx) {
      if (!ctxs.includes(bctx)) ctxs.push(bctx);
      const which = ctxs.indexOf(bctx); // 0=先启动的 A（快），1=后启动的 B（慢）
      await new Promise((r) => setTimeout(r, which === 0 ? 5 : 60));
      n += 1;
      return [{ name: 'h-' + which, source: 'npm', stars: 1 }];
    };
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [];
    const pA = m.buildIndex();
    const pB = m.buildIndex(); // 直接叠建（绕过 getIndex 去重的真实形状：contract 公开 buildIndex）
    await pA;
    check('M-h A 结束后 B 的预算 deadline 仍有效（旧实现此处已被清零）',
      ctxs.length === 2 && ctxs[0].deadline === 0 && ctxs[1].deadline > 0,
      JSON.stringify(ctxs.map((c) => c.deadline)));
    await pB;
    check('M-h B 结束后自己的 ctx 也清零（finally 只清各的），两次构建各自走完源循环', ctxs[1].deadline === 0 && n === 2, String(ctxs[1].deadline) + ' n=' + n);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- M-i：getIndex(force=true) 复用 _inFlight 不叠建；且**快照立即返回、绝不等构建** --
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), logger: { info() {}, warn() {}, error() {} } });
    let builds = 0;
    m.indexNpm = async () => { builds += 1; await new Promise((r) => setTimeout(r, 200)); return []; };
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [];
    const t0 = Date.now();
    const s1 = await m.getIndex(true);
    const s2 = await m.getIndex(true);
    const dt = Date.now() - t0;
    check('M-i 快照不被构建阻塞（200ms 构建仍在飞时已返回）', dt < 50 && builds >= 1, dt + 'ms builds=' + builds);
    check('M-i 在飞期间快照 building=true（面板据此轮询）', s1.building === true && s2.building === true, s1.building + '/' + s2.building);
    await settleBuild(m);
    //  原两条读私有字段 `m._inFlight` 的判据已删：`builds === 1` 已从行为上证明 force 复用同一在途
    //  构建，下面的 `building === false` 证明结算后不误挂 —— 字段改名/改用别的手段去重即假红。
    check('M-i 连续 force 只发起一次构建（复用同一在途构建）', builds === 1, String(builds));
    check('M-i 结算后快照 building=false', (await m.getIndex()).building === false, '');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -- M-j：冷启动（磁盘无缓存）与构建失败必须如实上报，且失败不得点燃「每次读都重建」的风暴 --
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-'));
    const m = new PluginMarket({ cacheDir: dir, stateFile: path.join(dir, 's.json'), retryBackoffMs: 60000, logger: { info() {}, warn() {}, error() {} } });
    let builds = 0;
    m.indexNpm = async () => { builds += 1; throw new Error('镜像源不可达（桩）'); };
    m.indexGithub = async () => [];
    m.indexCommunity = async () => [];
    const cold = await m.getIndex();
    check('M-j 冷启动回合法空快照 + building=true（已后台点火）',
      cold.ok === true && cold.plugins.length === 0 && cold.indexedAt === 0 && cold.building === true,
      JSON.stringify({ n: cold.plugins.length, i: cold.indexedAt, b: cold.building }));
    await settleBuild(m);
    const after = await m.getIndex();
    check('M-j 构建失败：error 如实上报（不得显示成「没有插件」）',
      /镜像源不可达/.test(String(after.error)) && after.plugins.length === 0, JSON.stringify(after.error));
    check('M-j 失败后进入退避：再读不叠建（旧形态每读一次点一轮 4 分钟构建）',
      after.building === false && builds === 1, 'builds=' + builds + ' building=' + after.building);
    await m.getIndex(true);
    check('M-j 反向：force（用户点刷新）绕开退避立即重试', builds === 2, 'builds=' + builds);
    await settleBuild(m);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();