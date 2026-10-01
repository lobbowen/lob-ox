#!/usr/bin/env node
'use strict';


// 插件管理双机制（原生宿主 x 沙箱实例）核心行为：卸载（官方 CLI + bundles + 跨层残留清理 + 运行中实例自动重启，
//   job 级核算）· 停用/启用（官方补丁层 $DSH_HOME/cordis.patch.yml 热载，不动 bundles，无需重启）·
//   更新（registry 最高版 vs 已装版 + 重启生效，本地/git 型拒绝）· 取不到版本要报「取不到 + 原因」· 检测「立即回快照 + 后台跑」。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
// 步骤8a（DIRECTORY-STRUCTURE-DESIGN）：plugin 域补 index.js，
// 原 plugins.js 拆为 index/ops/jobs/store（market.js 由 pluginmarket.js 改名）。
const { PluginManager } = require(path.join(ROOT, 'src', 'domains', 'plugin'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x ? '  ← ' + x : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitJob(pm, jobId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = pm.installStatus(jobId);
    if (j && (j.state === 'done' || j.state === 'failed')) return j;
    await sleep(15);
  }
  return pm.installStatus(jobId);
}

/** 检测读端点已不等 registry 往返（见 Q 组）：测试要读结论就显式等在飞收尾，再读一次快照。
 *  setImmediate 是必需的：`_updInFlight` 的摘除挂在在飞 promise 收尾链的**下一条微任务**上，
 *  只 await 它本身会读到尚未摘除的登记（Q3 因此在四平台同时判红）。 */
async function checkDone(pm, force) {
  await pm.checkUpdates(force);
  await settleInFlight(pm);
  return pm.checkUpdates();
}

/** 等在飞检测真正收尾并摘除登记（无在飞即直接返回）。 */
async function settleInFlight(pm) {
  if (!pm._updInFlight) return;
  await pm._updInFlight.catch(() => {});
  await new Promise((r) => setImmediate(r));
}

function initProfileDir(dir, deps, bundles) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'profile', private: true, dependencies: deps || {},
    dsh: { profile: { bundles: bundles || ['@deepseek-ai/dsh-base'] } }
  }, null, 2) + String.fromCharCode(10));
}

/** 真实临时 profile 目录 + 桩 CLI/instances/registry。opts: running/pnpmResult/pnpmError/bundlesClean/installedOnTargets/nativeRestart/distLatest */
function makePM(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-pm-'));
  const nativeProfile = path.join(tmp, 'native', 'profiles', 'web');
  const aProfile = path.join(tmp, 'inst-a', 'profiles', 'web');
  initProfileDir(nativeProfile, { '@x/p': '^1.0.0' }, ['@deepseek-ai/dsh-base', '@x/p']);
  initProfileDir(aProfile, { '@x/p': '^1.0.0' }, ['@deepseek-ai/dsh-base', '@x/p']);
  const overlayFile = path.join(tmp, 'plugin-states.patch.yml');
  fs.writeFileSync(overlayFile, JSON.stringify([{ id: 'include:p', disabled: true }], null, 2));

  const installedOnTargets = opts.installedOnTargets || ['native', 'inst-a'];
  const distCalls = []; // 取版本口的调用次数：区分「重新查询」与「命中缓存」的唯一依据
  const instances = {
    calls: [],
    states: { 'inst-a': opts.running !== false, 'inst-b': false, 'main': opts.running !== false },
    probeInstance(id) { this.calls.push('probe:' + id); return { pid: 1, running: !!this.states[id] }; },
    stopInstance(id) { this.calls.push('stop:' + id); this.states[id] = false; return { ok: true }; },
    async startInstance(id) { this.calls.push('start:' + id); this.states[id] = true; return { ok: true }; },
  };
  const NATIVE = { id: 'native', name: '原生实例', kind: 'native', profileDir: nativeProfile, profileName: 'web' };
  const A = { id: 'inst-a', name: '沙箱甲', kind: 'sandbox', profileDir: aProfile, profileName: 'web' };
  const pm = new PluginManager({
    dshBin: 'dsh', profileName: 'web', profileDir: nativeProfile, overlayFile,
    dshPort: 3080, instances: null, tasks: null, logger: { info() {}, warn() {}, error() {} },
    events: { append() {} },
    onNativeRestart: opts.nativeRestart || (() => { instances.calls.push('native-restart'); return { ok: true }; }),
    // 默认未退出；O 组用例注入 () => true 验证退出门。
    exitIntended: opts.exitIntended || (() => false),
    // dist 的取版本口回结构化结果（{ok,version,...}）：桩按包名给版本，缺键即「取不到」。
    dist: { fetchNpmLatest: async (n) => {
      distCalls.push(n);
      const v = opts.distLatest !== undefined ? opts.distLatest[n] : '2.0.0';
      return v ? { ok: true, version: v, origin: 'https://fake.registry', attempts: [], error: null }
        : { ok: false, version: null, origin: null, attempts: [{ origin: 'https://fake.registry', error: '桩：无该包' }], error: '桩：无该包' };
    } },
  });
  pm.instances = instances;
  pm._allSandboxTargets = () => [A];
  pm.resolveTargets = (str) => {
    if (str === 'native') return { ok: true, targets: [NATIVE] };
    if (str === 'all') return { ok: true, targets: [NATIVE, A] };
    if (str === 'inst-a') return { ok: true, targets: [A] };
    return { ok: false, error: 'no target ' + str };
  };
  pm.installedOn = (t) => installedOnTargets.includes(t.id) ? [{ name: '@x/p', version: '1.0.0', source: '@x/p', bundle: true }] : [];
  pm._runCli = async (target, args) => {
    instances.calls.push('cli:' + target.id + ':' + args.join(' '));
    const preset = typeof opts.pnpmResult === 'function' ? opts.pnpmResult(target, args) : opts.pnpmResult;
    if (preset) return { ok: true, error: null };
    return { ok: false, error: (opts.pnpmError !== undefined ? opts.pnpmError : '退出码 1') };
  };
  pm.inventory = async () => ({ entries: [{ entryId: 'e1', moduleName: '@x/p-something' }] });
  pm.saveOverlayEntries = (entries) => fs.writeFileSync(overlayFile, JSON.stringify(entries, null, 2) + String.fromCharCode(10));
  return { pm, instances, distCalls, tmp, aProfile, nativeProfile, overlayFile };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const homePatchFile = (profileDir) => path.join(path.dirname(path.dirname(profileDir)), 'cordis.patch.yml');

(async () => {
  // -- A. 卸载成功 + 运行中沙箱 -> 重启；bundles 移除 --
  {
    const { pm, instances, aProfile } = makePM({ running: true, pnpmResult: true });
    const before = (readJson(path.join(aProfile, 'package.json')).dsh.profile.bundles || []).slice();
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    const after = (readJson(path.join(aProfile, 'package.json')).dsh.profile.bundles || []);
    check('A1 卸载 job done 且运行中沙箱被重启',
      job.state === 'done' && instances.calls.includes('stop:inst-a') && instances.calls.includes('start:inst-a'),
      job.state + ' ' + instances.calls.join(','));
    check('A4 bundles 移除', before.includes('@x/p') && !after.includes('@x/p'), JSON.stringify(after));
  }
  // -- B. 卸载成功 + 实例未运行 -> 不重启 --
  {
    const { pm, instances } = makePM({ running: false, pnpmResult: true });
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    // job 语义断言必须在「job done」之后：只留语义会在 job 根本没跑完时空转通过。
    check('B1 卸载 job done 且未运行的实例不重启',
      job.state === 'done' && !instances.calls.includes('stop:inst-a') && !instances.calls.includes('start:inst-a'),
      job.state + ' ' + instances.calls.join(','));
  }
  // -- C. pnpm 报「依赖已不存在」+ bundles 已清理 -> 视为成功并重启 --
  {
    const { pm, instances } = makePM({
      running: true, pnpmResult: false,
      pnpmError: "ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS Cannot remove '@x/p': no such dependency found", bundlesClean: true
    });
    pm._removeFromProfileBundles = () => true;
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('C1/C2 依赖已移除判定为成功，且成功路径仍重启',
      job.state === 'done' && instances.calls.includes('start:inst-a'), job.state + ' ' + instances.calls.join(','));
  }
  // -- D. 硬失败（无 bundles 变更）-> job failed，不重启 --
  {
    const { pm, instances } = makePM({ running: true, pnpmResult: false, pnpmError: 'registry timeout', bundlesClean: false });
    pm._removeFromProfileBundles = () => false;
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    // job failed（真信号）与「失败不重启」同判：只留后者时 job 没跑起来也会假绿。
    check('D1 硬失败 job failed 且不重启',
      job.state === 'failed' && !instances.calls.includes('stop:inst-a'),
      job.state + ' ' + instances.calls.join(','));
  }
  // -- E. native 目标变更 + 运行中 -> onNativeRestart；不直接碰 systemd --
  {
    let nativeRestartCalls = 0;
    const { pm, instances } = makePM({ running: true, pnpmResult: true, nativeRestart: () => { nativeRestartCalls++; return { ok: true }; } });
    const r = await pm.uninstall('@x/p', 'native');
    const job = await waitJob(pm, r.jobId, 3000);
    check('E1/E2 原生卸载 job done，且原生走 supervisor 重启回调恰好一次',
      job.state === 'done' && nativeRestartCalls === 1, job.state + ' calls=' + nativeRestartCalls);
  }
  // -- F0. 行保留回归：禁用/启用不得误删补丁层中的非 disabled 用户行/insert 行--
  {
    const { pm, aProfile } = makePM({ running: true });
    const hpFile = homePatchFile(aProfile);
    // 预置：本插件既有 disabled:false 行 + 与插件同 id 的 insert 型行 + 其它插件行
    fs.writeFileSync(hpFile, JSON.stringify([
      { id: '@x/p', enabled: true },                    // 用户手动配置行（非 disabled）
      { insert: [{ id: 'x-util', name: '@x/p' }] },      // insert 型行（引用该插件）
      { id: '@y/q', disabled: true },                    // 其它插件禁用行（不得受影响）
    ], null, 2));
    // 禁用：应保留 enabled/insert/其它插件行，仅将 @x/p 行置 disabled
    await pm.setBundleEnabled('@x/p', false, 'inst-a');
    let hp = readJson(hpFile) || [];
    const ownRow = hp.find((e) => e && e.id === '@x/p');
    check('F0.1 禁用后本插件行 disabled=true', !!ownRow && ownRow.disabled === true, JSON.stringify(hp));
    // 「无关行不丢」的两个方向 × 两种行型：禁用侧一条、启用侧一条（同一判据不留四份采样）。
    const insertKept = () => (readJson(hpFile) || []).some((e) => Array.isArray(e.insert) && e.insert.some((r) => r.name === '@x/p'));
    const otherKept = () => (readJson(hpFile) || []).some((e) => e.id === '@y/q' && e.disabled === true);
    check('F0.2 禁用保留 insert 型行与其它插件禁用行', insertKept() && otherKept(), JSON.stringify(hp));
    // 启用：应移除本插件 disabled 行（禁用态整体移除为本产品语义），但 insert/其它插件行绝不丢
    await pm.setBundleEnabled('@x/p', true, 'inst-a');
    hp = readJson(hpFile) || [];
    check('F0.4 启用后无本插件 disabled 行', !hp.some((e) => e && e.id === '@x/p'), JSON.stringify(hp));
    check('F0.5 启用同样保留 insert 型行与其它插件行（与禁用侧同一个「无关行不丢」判据）',
      insertKept() && otherKept(), JSON.stringify(hp));
  }
  // -- F1. 禁用（沙箱）：写 home 补丁层，不动 bundles，不重启（热应用）--
  {
    const { pm, instances, aProfile } = makePM({ running: true });
    const res = await pm.setBundleEnabled('@x/p', false, 'inst-a');
    const hp = readJson(homePatchFile(aProfile)) || [];
    const bundles = (readJson(path.join(aProfile, 'package.json')).dsh.profile.bundles || []);
    const disabledRow = hp.find((e) => e.id === '@x/p');
    check('F1.1/F1.2 返回 rows=1，且 home 补丁层写入 disabled 行', res.ok === true && res.rows === 1 && !!disabledRow && disabledRow.disabled === true, JSON.stringify({ res, hp }));
    check('F1.3/F1.4 不动 bundles（防 reconcile 击穿）且不重启（热应用）',
      bundles.includes('@x/p') && !instances.calls.includes('stop:inst-a') && !instances.calls.includes('start:inst-a'), JSON.stringify({ bundles, calls: instances.calls }));
  }
  // -- F2. 启用（沙箱）：移除禁用行 --
  {
    const { pm, aProfile } = makePM({ running: true });
    await pm.setBundleEnabled('@x/p', false, 'inst-a');
    const res2 = await pm.setBundleEnabled('@x/p', true, 'inst-a');
    const hp = readJson(homePatchFile(aProfile)) || [];
    check('F2.1 启用后禁用行移除', res2.rows === 1 && !hp.some((e) => e.id === '@x/p'), JSON.stringify(hp));
  }
  // -- G. 安装成功 + 运行中沙箱 -> 不自动重启，仅提示 --
  {
    const { pm, instances } = makePM({ running: true, pnpmResult: true });
    const r = await pm.install('@x/p', { target: 'inst-a' });
    const job = await waitJob(pm, r.jobId, 3000);
    check('G1 安装 job done 且不自动重启（仅提示下次重启加载）',
      job.state === 'done' && !instances.calls.includes('stop:inst-a') && !instances.calls.includes('start:inst-a'),
      job.state + ' ' + instances.calls.join(','));
  }
  // -- H. all：native 失败 + 沙箱成功 -> job failed（部分目标失败）--
  {
    const { pm, instances } = makePM({ running: true, pnpmResult: (t) => t.kind === 'sandbox', pnpmError: 'registry timeout', bundlesClean: false });
    pm._removeFromProfileBundles = () => false;
    const r = await pm.uninstall('@x/p', 'all');
    const job = await waitJob(pm, r.jobId, 5000);
    check('H1/H2 部分失败 job failed，且失败目标带 error 记录',
      job.state === 'failed' && (job.targets.find((t) => t.id === 'native') || {}).error === 'registry timeout', job.state);
    check('H3 成功目标仍重启', instances.calls.includes('start:inst-a'), instances.calls.join(','));
  }
  // -- I. _removeFromProfileBundles 真实写盘：幂等 --
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-rm-'));
    const profileDir = path.join(tmp, 'profile');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@x/p'] } } }, null, 2));
    const pm = new PluginManager({ dshBin: 'x', profileName: 'web', profileDir: '/nonexistent', overlayFile: '/nonexistent', dshPort: 1, logger: console });
    const removed = pm._removeFromProfileBundles({ profileDir }, '@x/p');
    const after = readJson(path.join(profileDir, 'package.json'));
    check('I1/I2 bundles 移除返回 true 且插件从 bundles 消失',
      removed === true && !(after.dsh.profile.bundles || []).includes('@x/p'), String(removed));
    check('I3 二次移除返回 false（幂等）', pm._removeFromProfileBundles({ profileDir }, '@x/p') === false, '');
  }
  // -- J. 卸载残留清理（home 补丁层 / overlay / profile 补丁层 JSON）--
  {
    const { pm, aProfile, overlayFile } = makePM({ running: true, pnpmResult: true });
    const hpFile = homePatchFile(aProfile);
    fs.writeFileSync(hpFile, JSON.stringify([{ id: '@x/p', disabled: true }], null, 2) + String.fromCharCode(10));
    fs.writeFileSync(path.join(aProfile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'x-util', name: '@x/p' }] }], null, 2) + String.fromCharCode(10));
    const r = await pm.uninstall('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    const hpAfter = readJson(hpFile) || [];
    const ppAfter = readJson(path.join(aProfile, 'cordis.patch.yml')) || [];
    check('J1/J2 卸载 job done，且 home 补丁层残留已清',
      job.state === 'done' && !hpAfter.some((e) => e.id === '@x/p'), job.state);
    check('J3 profile 补丁层 insert 残留已清（纯 JSON 可安全改写）', !ppAfter.some((e) => (e.insert || []).some((row) => row.name === '@x/p')), JSON.stringify(ppAfter));
  }
  // -- K. 启用 native：清 legacy overlay 禁用行 --
  {
    const { pm, overlayFile } = makePM({ running: true });
    const before = readJson(overlayFile) || [];
    if (before.some((e) => e.id === 'include:p')) {
      const res = await pm.setBundleEnabled('@x/p', true, 'native');
      const after = readJson(overlayFile) || [];
      check('K1 启用时清理 legacy overlay', res.rows >= 1 && !after.some((e) => e.id === 'include:p'), JSON.stringify(after));
    } else { check('K1 启用时清理 legacy overlay', false, 'seed missing'); }
  }
  // -- L. 更新：检测 + 执行 + 重启 --
  {
    const { pm, instances } = makePM({ running: true, pnpmResult: true, distLatest: { '@x/p': '2.0.0' } });
    const chk = await checkDone(pm);
    const uc = (chk.plugins || []).find((x) => x.name === '@x/p');
    check('L1/L2 检测到可更新（npm 型）且含两个目标明细',
      !!uc && uc.updateAvailable === true && uc.specType === 'npm' && uc.targets.length === 2 && uc.targets.every((t) => t.updateAvailable), JSON.stringify(uc));
    const r = await pm.update('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('L3 更新 job done 且更新后重启', job.state === 'done' && instances.calls.includes('start:inst-a'),
      job.state + ' ' + instances.calls.join(','));
    check('L4 更新走官方 update 命令', instances.calls.some((c) => c.startsWith('cli:inst-a:update @x/p@2.0.0')), instances.calls.join(','));
  }
  // -- M. 更新已是最新 -> 跳过不执行 --
  {
    const { pm, instances } = makePM({ running: true, distLatest: { '@x/p': '1.0.0' } });
    const r = await pm.update('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('M1/M2 已最新 job done、不重启、不执行更新命令',
      job.state === 'done' && !instances.calls.includes('start:inst-a') && !instances.calls.some((c) => c.startsWith('cli:inst-a:update')), job.state + ' ' + instances.calls.join(','));
  }
  // -- N. 本地型插件更新 -> 拒绝并失败 --
  {
    const { pm, instances } = makePM({ running: true, distLatest: { '@x/p': '2.0.0' } });
    pm.installedOn = (t) => [{ name: '@x/p', version: '1.0.0', source: 'file:/home/me/dev/x', bundle: true }];
    const r = await pm.update('@x/p', 'inst-a');
    const job = await waitJob(pm, r.jobId, 3000);
    check('N1/N2 本地型更新 job failed 且不执行 CLI',
      job.state === 'failed' && !instances.calls.some((c) => c.startsWith('cli:inst-a:update')), job.state + ' / ' + (job.error || ''));
  }
  // -- O. 退出门约束插件变更生效重启 --
  //   本测试注入的是裸 instances（无外层适配器门）——域侧必须自查 ctx.exitIntended。
  {
    const A_TGT = { id: 'inst-a', name: '沙箱甲', kind: 'sandbox', profileDir: 'p', profileName: 'web' };
    const NAT_TGT = { id: 'native', name: '原生实例', kind: 'native', profileDir: 'p', profileName: 'web' };
    const { pm, instances } = makePM({ running: true, exitIntended: () => true });
    check('O1/O2 沙箱目标退出中 → 不生效(false) 且零停起调用',
      (await pm._applyPluginChange(A_TGT, 'uninstall', () => {})) === false
      && !instances.calls.some((c) => c.startsWith('stop:') || c.startsWith('start:')), instances.calls.join(','));
    check('O3 原生目标：退出中 → 不触发 onNativeRestart', await pm._applyPluginChange(NAT_TGT, 'update', () => {}) === false, '');
    const { pm: pm2, instances: inst2 } = makePM({ running: true });
    check('O5 反向（门有牙）：未退出 → 正常重启生效', await pm2._applyPluginChange(A_TGT, 'uninstall', () => {}) === true && inst2.calls.includes('start:inst-a'), inst2.calls.join(','));
  }

  // -- P. registry 取不到版本：如实上报原因，且失败结论不落进检测缓存 --
  //   latestCached 只在取到时写缓存；把「取不到」写进去等于 TTL 之久面板都显示「无更新」，
  //   而这两件事对用户是同一个症状、却是完全不同的处置（重试 vs 等发版）。
  {
    const { pm, instances, distCalls } = makePM({ running: true, distLatest: {} });
    const r = await pm.update('@x/p', 'inst-a');
    check('P1/P2 取不到版本时 update 直接失败并带上逐源原因，且零 CLI、零重启（不得静默走「已是最新」分支）',
      r.ok === false && /桩：无该包/.test(String(r.error)) && r.jobId === undefined
      && !instances.calls.some((c) => c.startsWith('cli:') || c.startsWith('start:')), JSON.stringify(r));
    check('P3 失败结论不落进检测缓存', pm._updCache['@x/p'] === undefined, JSON.stringify(pm._updCache));
    const chk = await checkDone(pm);
    const row = (chk.plugins || []).find((x) => x.name === '@x/p');
    check('P4a 检测：取不到时逐目标 latest 为 null 且逐目标/行级 updateAvailable 全为 false（正向对照见 L1/L2）',
      !!row && row.targets.length === 2 && row.targets.every((t) => t.latest === null)
      && row.updateAvailable === false && row.targets.every((t) => t.updateAvailable === false),
      JSON.stringify(row && { u: row.updateAvailable, t: row.targets.map((x) => x.updateAvailable) }));
    check('P4c 原因随行走：逐插件带原始原因，汇总按「包名: 原因」拼接（面板据此不再显示成「已是最新」）',
      !!row && row.error === '桩：无该包' && chk.error === '@x/p: 桩：无该包', JSON.stringify({ r: row && row.error, a: chk.error }));
    await checkDone(pm, true);
    check('P5 门禁非空转：失败后再 force 检测仍重新查询，而不是被负缓存挡掉', distCalls.length === 3, String(distCalls.length));
    const { pm: pm2, distCalls: calls2 } = makePM({ running: true, distLatest: { '@x/p': '2.0.0' } });
    await checkDone(pm2);
    pm2._updSnapshot = null;   // 冷读动态（快照过期/重启后）：是否触网只由逐插件缓存决定
    await checkDone(pm2);
    check('P6 反向对照：取到版本才写逐插件缓存，快照过期后仍不触网',
      calls2.length === 1 && pm2._updCache['@x/p'] && pm2._updCache['@x/p'].latest === '2.0.0',
      calls2.length + ' / ' + JSON.stringify(pm2._updCache));
  }

  // -- Q. 检测读端点不等长动作：立即回快照 + refreshing 标记（与 /plugins/market 同一口径） --
  {
    const { pm } = makePM({ running: true, distLatest: { '@x/p': '2.0.0' } });
    let release;
    const gate = new Promise((r) => { release = r; });
    pm.dist.fetchNpmLatest = async (n) => { await gate; return { ok: true, version: '2.0.0', origin: 'https://fake.registry', attempts: [], error: null }; };
    const t0 = Date.now();
    const first = await pm.checkUpdates(true);
    const dt = Date.now() - t0;
    check('Q1 registry 未回时读端点已返回',
      dt < 100 && first.refreshing === true && first.checkedAt === 0 && (first.plugins || []).length === 0,
      dt + 'ms ' + JSON.stringify({ r: first.refreshing, c: first.checkedAt }));
    release();
    await settleInFlight(pm);
    const done = await pm.checkUpdates();
    check('Q3 在飞收尾后快照给出结论且 refreshing=false',
      done.refreshing === false && done.checkedAt > 0 && done.error === null
      && (done.plugins || []).length === 1 && done.plugins[0].updateAvailable === true,
      JSON.stringify({ r: done.refreshing, n: (done.plugins || []).length }));
  }

  // -- R. 补丁层写队列：一次写盘异常**不得毒化**队列 --
  //   入队若无 catch，一次 EACCES/EIO/ENOSPC 后队列永久 rejected ⇒ 之后每次 enable/disable 写盘根本不发生。
  {
    const logs = [];
    const wq = new PluginManager({ logger: { error: (m) => logs.push(String(m)), warn() {}, info() {} }, dist: null, tasks: null });
    let inner = 0;
    wq._setBundleEnabledInner = () => { inner++; if (inner === 1) throw new Error('boom-write-fail'); return { ok: true, n: inner }; };
    //  逐调用 try/catch：队列中毒后这里会抛 rejection，不接住进程会直接崩掉、只留退出码而没有可读的 FAIL 行。
    const call = async (fn) => { try { return await fn(); } catch (e) { return { __rejected: true, error: (e && e.message) || String(e) }; } };

    const r1 = await call(() => wq.setBundleEnabled('p1', false, 'native'));
    check('R1 首次异常如实上报（不吞错、不静默：ok:false + 原因 + 有日志）',
      r1 && r1.ok === false && /boom-write-fail/.test(r1.error || '') && logs.some((l) => /boom-write-fail/.test(l)),
      JSON.stringify(r1) + ' logs=' + logs.length);

    const r2 = await call(() => wq.setBundleEnabled('p2', false, 'native'));
    const r3 = await call(() => wq.setBundleEnabled('p3', false, 'native'));
    check('R2 异常后队列未毒化：后续两次调用仍执行内层',
      r2 && r2.ok === true && r2.n === 2 && r3 && r3.ok === true && inner === 3, JSON.stringify({ r2, r3, inner }));

    // 卸载路径（_scrubPluginLayers）共用同一队列：异常同样不得毒化
    let scrubInner = 0;
    wq._scrubPluginLayersInner = () => { scrubInner++; if (scrubInner === 1) throw new Error('scrub-boom'); return { ok: true }; };
    const s1 = await call(() => wq._scrubPluginLayers('native', 'x', null));
    const s2 = await call(() => wq._scrubPluginLayers('native', 'x', null));
    check('R3 scrub 首次异常如实上报且第二次仍执行',
      s1 && s1.ok === false && s2 && s2.ok === true && scrubInner === 2, JSON.stringify({ s1, s2, scrubInner }));

    // 反向：两条路径必须共用**同一**串行队列（否则丢更新防线失效）。行为判据：
    //   让 set 内层先挂起再发起 scrub；共用同一队列则 scrub 内层必须等 set 内层结束后才启动。
    let releaseSet;
    const gate = new Promise((res) => { releaseSet = res; });
    const seq = [];
    wq._setBundleEnabledInner = async () => { seq.push('set:start'); await gate; seq.push('set:end'); return { ok: true }; };
    wq._scrubPluginLayersInner = async () => { seq.push('scrub:start'); return { ok: true }; };
    const pSet = wq.setBundleEnabled('p4', false, 'native');
    const pScrub = wq._scrubPluginLayers('native', 'x', null);
    await new Promise((res) => setTimeout(res, 20));
    const midSeq = seq.slice();
    releaseSet();
    await Promise.all([pSet, pScrub]);
    check('R4/R5 反向：后一写不得越过前一写，两条路径共用同一串行队列（顺序 set->scrub）',
      midSeq.length === 1 && midSeq[0] === 'set:start' && seq.join(',') === 'set:start,set:end,scrub:start', JSON.stringify(seq));
  }

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
