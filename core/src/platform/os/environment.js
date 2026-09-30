'use strict';

// 环境表单（外部打开链路的最底层）：把「这台机器与本产品相关的实况」按**维度**收齐并常驻呈现 ——
//   装了哪些浏览器、系统说不出哪个是默认、有没有图形会话、用户在本产品里选过谁、跑内核的这套
//   运行时（node/npm/镜像源/全局前缀）到不到位、这台机器往外走不走得出去，每条结论是从哪条系统事实读来的。
//   后续动作只从这张表分发（选路见 pickLauncher，执行见 ./browser.js）。
//
// 为什么要一张表而不是各动作各探各的：直启打开与登录隔离窗此前各自摸系统事实、各自解释结果，
//   于是「面板说交出去了、屏幕上什么都没有」在真机上无从定性。表单收敛的是**事实与分发依据**，
//   不是又一个调用口：动作层只问「这次该用谁」，不再问「系统里有什么」。
// 为什么要维度化（schema 2）：同一件事此前有三份实现 —— 壳的 domain/probes.rs、内核的 EnvCatalog、
//   本文件的浏览器单节。三份各自「探测 + 缓存 + 呈现」，面板上同一台机器就有三个就绪口径。
//   维度台账收敛的是**账本形状**（每个维度一条 {at, source, state, data, probed}），不是采集实现：
//   采集仍归各自的所有者，用 registerSection() 把**既有探针**挂进来（零第二份实现），
//   本文件只负责按拍装配、失效与落盘。
//   壳那一份采集结果经 ../contract/shell-report 以 `shell` 维进同一张表：一张表、按来源留痕，
//   并排而不互相覆盖（两份实测不一致本身就是要看的证据，见该维度注册处的说明）。
// 平台事实仍只写在 ./browser-inventory.js 与 ./egress.js 一处：本文件不查注册表、不跑 LaunchServices 脚本、
//   不扫 XDG 目录、不自己摸网络，只做表单装配、选路次序与快照落盘（shell 维只读一个本地小文件）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stateRoot = require('../service/state-root');
const { writeAtomic } = require('../util/fs');
const { maskProxyServer, maskProxySecrets } = require('../util/redact');
const desktop = require('./desktop');
const detector = require('./browser-inventory');
const egress = require('./egress');
const shellReport = require('../contract/shell-report');
const { engineOf } = detector;

/** 快照 schema：落盘格式变更时递增，读侧据此判旧快照是否作废（不得按字段猜版本）。
 *  2 = 维度台账（sections）进快照：只有浏览器单节的快照撑不起「本机实况」这句话。 */
const SCHEMA = 2;

/** 快照文件名（落在本产品状态目录，与 config/state 同处）。 */
const FILE_NAME = 'environment.json';

/** 表单缓存窗口：与探测层的清单缓存同量级，面板轮询不得把系统查询变成常态开销。 */
const FORM_TTL_MS = 60000;

/** 维度默认复用窗口：出网条件与运行时探测都比「读一次文件」贵得多，按维度各自 ttlMs 覆盖。 */
const SECTION_TTL_MS = 60000;

/** 壳上报维度的复用窗口：读一次小文件近乎免费，取短窗口是为了「壳刚重探完，面板下一拍就能看到」。
 *  这里没有「等壳上报」的轮询，也没有超时判失败 —— 报告旧到什么程度由 data.ageMs 如实交出。 */
const SHELL_REPORT_TTL_MS = 10000;

/** 装配期注入的取数口。platform 不得 require app/api（分层门禁 L-1），而「用户的偏好」住在内核配置里、
 *  「能力矩阵的实测覆写」住在 ./index.js 里，两者都只能由上层在组装时把 getter 绑进来。
 *  绑一次即全局生效，调用点不必层层传参 —— 漏传一处就是一条静默降级路（偏好被忽略、界面仍显示已选）。 */
let _sources = {};

/** @param {{preference?:Function, capabilities?:Function}} sources 同名覆盖，未给的保持原状。 */
function bind(sources) {
  _sources = Object.assign({}, _sources, sources || {});
  return _sources;
}

/** 用户在本产品里选的浏览器（配置项 id）；未绑定或值为空即 null。 */
function preferenceId() {
  const f = _sources.preference;
  if (typeof f !== 'function') return null;
  const v = f();
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 能力矩阵（含实测覆写的最终档位）；未绑定即 null，表单如实标「未绑定」而不冒充一份档位。 */
function capabilities() {
  const f = _sources.capabilities;
  if (typeof f !== 'function') return null;
  return f() || null;
}

/** 本机身份（只读，零 spawn、零网络）。userInfo 在部分服务语境会抛，故落到环境变量。 */
function identity() {
  let user = null;
  try { user = os.userInfo().username; } catch { user = process.env.USER || process.env.USERNAME || null; }
  return {
    platform: process.platform, arch: process.arch,
    hostname: os.hostname(), user: user || null, home: os.homedir(), node: process.version,
  };
}

/** 本产品状态落点（快照写在这里；被管控对象的数据目录不属于本表单）。 */
function paths() {
  return { root: stateRoot.root(), supervisor: stateRoot.supervisorDir(), shell: stateRoot.shellDir() };
}

/** 候选清单的规整形态：engine 恒有值（探测层漏填时按可执行文件名现推），isDefault 按系统默认项标定。
 *  表单与选路共用这一份，避免出现「面板显示两个、实际按第三个启动」。 */
function normalizeInventory(inv, platform) {
  const list = inv && Array.isArray(inv.browsers) ? inv.browsers : [];
  const defaultId = inv && inv.defaultId ? inv.defaultId : null;
  return {
    platform: (inv && inv.platform) || platform || process.platform,
    cached: !!(inv && inv.cached),
    at: inv && inv.at !== undefined ? inv.at : null,
    defaultId,
    defaultSource: (inv && inv.defaultSource) || null,
    browsers: list.map((b) => ({
      id: b.id,
      name: b.name,
      bin: b.bin,
      engine: b.engine || engineOf(b.bin),
      baseArgs: b.baseArgs || [],
      sources: b.sources && b.sources.length ? b.sources : [b.source || 'unknown'],
      isDefault: !!defaultId && b.id === defaultId,
    })),
    probed: (inv && inv.probed) || [],
  };
}

/** 浏览器候选清单（探测层的原样视图 + 表单补上的判定字段）。
 *  @param {{force?:boolean, platform?:string, inventory?:object, resolveInventory?:Function, resolveDeps?:object}} [o]
 *    注入缝供行为测试：CI 机器不真查注册表，夹具与选路必须同源。 */
function browsers(o) {
  const ov = o || {};
  const pl = ov.platform || process.platform;
  if (ov.inventory) return normalizeInventory(ov.inventory, pl);
  const resolve = typeof ov.resolveInventory === 'function' ? ov.resolveInventory
    : ((platform, deps) => detector.inventory(platform, deps));
  return normalizeInventory(resolve(pl, ov.resolveDeps || {}), pl);
}

/** 候选次序（纯函数）：引擎族是「裸 URL 直启的参数语义是否确定」的唯一分级依据 ——
 *  chromium / firefox 两族已知，other（Safari、打包器包装）连能否带地址直启都不确定。
 *  同族按 id 字典序，保证同一台机器每次给出同一个答案，不随清单产出顺序漂移。 */
const ENGINE_RANK = { chromium: 0, firefox: 1, other: 2 };
function rankCandidates(list) {
  const rankOf = (b) => {
    const r = ENGINE_RANK[b && b.engine];
    return r === undefined ? ENGINE_RANK.other : r;
  };
  return (Array.isArray(list) ? list : []).slice().sort((a, b) => {
    if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    const ia = String((a && a.id) || '');
    const ib = String((b && b.id) || '');
    return ia < ib ? -1 : (ia > ib ? 1 : 0);
  });
}

/** 分发依据（纯函数）：这次交给哪个浏览器。四层优先级，写在这里一次，动作层不再自己判：
 *  1) 用户在本产品里选过的偏好 —— 只在它仍是当前候选时作数；
 *  2) 系统自己说得出的默认项（认 defaultId 字段，来源名由探测层给，本层不认具体名字）；
 *  3) 穷举后的唯一候选（唯一解，不是选择）；
 *  4) 候选多个而系统说不出默认：按候选次序取首个（how='candidate-rank'）并留痕。
 *  第 4 层是本轮的收口点：真机形状正是「装了多个浏览器但读不到用户选择」，旧实现在此返回空对象、
 *  整条链路报 no-launcher，用户看到的是「点一键登录什么都没弹」。
 *  偏好所指被卸载/不可执行时不静默换人：回落并在 stale 里如实标出，面板据此提示重选。
 *  @param {string} [platform]
 *  @param {object} inv 规整后的候选清单（normalizeInventory / browsers 的返回）
 *  @param {string|null} [preference] 显式传 null 表示「无偏好」；不传则取装配期绑定的偏好
 *  @returns {{browser:object|null, how:string, wanted:string|null, stale:boolean}} */
function pickLauncher(platform, inv, preference) {
  const list = inv && Array.isArray(inv.browsers) ? inv.browsers : [];
  const byId = new Map();
  for (const b of list) byId.set(b.id, b);
  const wanted = preference === undefined ? preferenceId()
    : (typeof preference === 'string' && preference ? preference : null);
  const stale = wanted !== null && !byId.has(wanted);
  const out = (browser, how) => ({ browser, how, wanted, stale });
  if (wanted !== null && byId.has(wanted)) return out(byId.get(wanted), 'user-preference');
  const sys = inv && inv.defaultId ? byId.get(inv.defaultId) : null;
  if (sys) return out(sys, inv.defaultSource || 'default');
  if (list.length === 1) return out(list[0], 'only-installed');
  if (list.length > 1) return out(rankCandidates(list)[0], 'candidate-rank');
  return out(null, 'none-found');
}

// ---- 维度台账 ----
// _sections：注册表（谁提供这一维）；_reads：每维最后一次读数（{at, source, state, data, error}）。
// 分开两份是必需的：注册发生在装配期，读数发生在刷新期，而 form() 必须同步可读（选路当场要用）。
const _sections = new Map();
const _reads = new Map();

/** 面板与快照的固定呈现次序；未列出的注册维度追加在后面（不藏维度）。
 *  shell 紧跟 runtime：两维量的是同一批事实（本机 Node/npm/镜像源/前缀），只是采集者不同 ——
 *  并排放，两份实测不一致时一眼看得见，中间隔开就等于把矛盾拆成两个页面。
 *  startup 在最后：它是「这一拍本机跑过什么」的元信息，不参与任何分发判定，但排障时必须在一起。 */
const SECTION_ORDER = ['runtime', 'shell', 'dsh', 'browsers', 'session', 'egress', 'capabilities', 'preference', 'pick', 'startup'];

/** 表单自己装配的同步维度：这些名字由本文件每拍现装，不接受外部注册（注册即两个口径）。 */
const SYNC_DIMS = ['browsers', 'session', 'capabilities', 'preference', 'pick'];

/** 注册一个环境维度（app 层在装配期调用；platform 不得反向 require app，L-1）。
 *  probe 同步或异步都收：异步维度（子进程/网络）只由 refresh() 拍，同步维度不得在 HTTP 路径上跑。
 *  @param {string} id 维度名（进 sections/快照，故必须稳定）
 *  @param {{label?:string, probe:Function, ttlMs?:number, source?:string}} def
 *  @returns {object} 注册后的定义 */
function registerSection(id, def) {
  if (!id || !def || typeof def.probe !== 'function') throw new Error('registerSection(' + id + ') 需要 probe 函数');
  if (SYNC_DIMS.includes(id)) throw new Error('维度 ' + id + ' 由表单每拍自装，不接注册');
  const d = { id, label: def.label || id, probe: def.probe, ttlMs: def.ttlMs === undefined ? SECTION_TTL_MS : def.ttlMs, source: def.source || 'registered' };
  _sections.set(id, d);
  _reads.delete(id); // 换探针即作废旧读数：留着上一版数据冒充本机实况是最难查的假账
  return d;
}

function unregisterSection(id) {
  _sections.delete(id);
  _reads.delete(id);
}

/** 某维度当前读数（同步取；绝不在这里触发探测）。未注册也未读过即 null，读过但失败 = state='error'。 */
function section(id) {
  return _reads.get(id) || null;
}

function sectionData(id) {
  const r = _reads.get(id);
  return r ? r.data || null : null;
}

/** 出网条件维度的数据装配：代理读数 + 已判过的目标主机，全部三态原样交出（不把 null 折成 false）。
 *  代理地址的脱敏在 ../util/redact（入站边界的唯一一把尺），本维度只在装配时过一次。 */
function proxyDataOf(p) {
  return p ? { state: p.state, server: maskProxyServer(p.server), pac: p.pac || null, source: p.source, cached: p.cached === true } : null;
}
function egressData(proxyReading) {
  const targets = {};
  for (const h of egress.hosts()) {
    const r = egress.reachRead(h);
    if (r) targets[h] = { ok: r.ok === null ? null : r.ok === true, stage: r.stage, detail: r.detail, at: r.at };
  }
  const p = proxyReading || egress.proxyRead();
  const probed = [];
  if (p) {
    for (const row of (p.probed || [])) probed.push({ source: row.source, detail: maskProxySecrets(String(row.detail || '')) });
    probed.push({ source: p.source, detail: 'proxy=' + p.state + (p.server ? ' (' + maskProxyServer(p.server) + ')' : '') + (p.cached ? ' 复用' : '') });
  } else {
    probed.push({ source: 'egress', detail: '系统代理未读（本维度尚未刷新）' });
  }
  for (const h of Object.keys(targets)) {
    const t = targets[h];
    probed.push({ source: 'reach:' + h, detail: (t.ok === null ? 'unknown' : (t.ok ? 'ok' : 'no-route')) + '@' + t.stage + ' ' + t.detail });
  }
  return {
    at: p ? p.at : null,
    proxy: proxyDataOf(p),
    targets,
    probed,
  };
}

/** 内置维度：出网条件。注册在本文件加载时，因为它的采集口（./egress.js）就在同层；
 *  运行时与 DSH 两维不在这里注册 —— 它们的探针住在 app/service 层，由装配期挂进来（见 registerSection）。
 *  force 一路传到 L0：面板点「刷新」就是要重问系统一遍，复用 60s 前的代理读数等于没刷。 */
registerSection('egress', {
  label: '出网条件',
  source: 'self',
  probe: (o) => {
    const ov = o || {};
    const force = ov.force === true;
    const hosts = Array.isArray(ov.hosts) ? ov.hosts : egress.hosts();
    const reachOpts = { force, timeoutMs: ov.timeoutMs, lookup: ov.lookup, connect: ov.connect, ttlMs: ov.ttlMs };
    return Promise.all([egress.proxy(Object.assign({}, ov, { force }))]
      .concat(hosts.map((h) => egress.reach(h, reachOpts))))
      .then(([p]) => egressData(p));
  },
});

/** 内置维度：桌面壳所见。注册在本文件加载时，因为它的采集口（../contract/shell-report）也在 platform 层。
 *  为什么与 runtime 并存而不是互相覆盖：壳与内核量的是同一批事实（Node/npm/镜像源/全局前缀），
 *    但**壳那一份是「装内核时真正用的那一套」**（它的 npm 探针真实执行过，见不变量 T-1b/T-10），
 *    内核这一份是「本进程现在解析到的」。两者不一致正是要排障的东西 —— 谁盖住谁都会把
 *    「探针的 npm 与装内核的 npm 不是同一个」这类缺陷重新藏起来。所以这里只如实并排，不裁决。
 *  壳未上报（内核独立跑、CLI、老版本壳）时本维度 available=false 并带原因，不是失败也不是空清单。 */
registerSection('shell', {
  label: '桌面壳所见（Node/npm/镜像源/全局前缀）',
  source: 'shell',
  ttlMs: SHELL_REPORT_TTL_MS,
  probe: () => shellReport.read(),
});

/** 拍一个维度：跑 probe、按结果定 state、失败只记账不抛（表单不得成为用户可见的失败原因）。 */
async function probeSection(id, o) {
  const def = _sections.get(id);
  if (!def) return null;
  const ov = o || {};
  const now = typeof ov.now === 'function' ? ov.now : Date.now;
  try {
    const data = await def.probe(ov);
    _reads.set(id, { at: now(), source: def.source, label: def.label, state: data ? 'ok' : 'empty', data: data || null, error: null });
  } catch (e) {
    _reads.set(id, { at: now(), source: def.source, label: def.label, state: 'error', data: null, error: String((e && (e.code || e.message)) || e) });
  }
  return _reads.get(id);
}

/** 到期的维度才重探：`force` 与 ttl 是仅有的两条重探路，常态刷新只补到期的那几个。 */
function staleOf(id, now, force) {
  if (force) return true;
  const def = _sections.get(id);
  const read = _reads.get(id);
  if (!def || !read) return true;
  return now - read.at >= def.ttlMs;
}

/** 异步刷新：把所有（或 only 指定的）维度按拍补齐，再交一份表单。
 *  启动装配、面板 ?force=1、改偏好后各拍一次；HTTP 路径只走这条与同步 form()，
 *  同步 exec 冻结事件循环的老路（B1-6）不得再出现在本文件。
 *  @param {{only?:string[], force?:boolean, persist?:boolean, platform?:string, inventory?:object,
 *           resolveInventory?:Function, resolveDeps?:object, now?:Function}} [o]
 *  @returns {Promise<object>} form() 的产物 */
async function refresh(o) {
  const ov = o || {};
  const now = typeof ov.now === 'function' ? ov.now : Date.now;
  const ids = Array.isArray(ov.only) && ov.only.length ? ov.only : [..._sections.keys()];
  await Promise.all(ids.filter((id) => _sections.has(id) && staleOf(id, now(), ov.force))
    .map((id) => probeSection(id, ov)));
  return form(Object.assign({}, ov, { force: true }));
}

/** 当场判一次「这次隔离登录的冷档案能不能出内容」（异步、有界，是 coldProfileViable 唯一取数入口）。
 *  为什么由表单而不是动作层做：动作层要的是结论，不是又一次自己摸系统 —— 与 pickLauncher 同一分工。
 *  本函数**永不抛错**：判不出就是 viable:null（保持隔离档），出网探测绝不能变成用户可见的失败原因。
 *  @param {string} url 本次要打开的地址（取其主机名做判定对象）
 *  @param {{egress?:object, lookup?:Function, connect?:Function, force?:boolean, ttlMs?:number,
 *           timeoutMs?:number, now?:Function}} [o] `egress` 为注入缝：给定读数即不摸网（CI 与行为测试同源）
 *  @returns {Promise<{host:string|null, viable:boolean|null, basis:string, detail:string, proxy:string, at:number|null}>} */
async function checkEgress(url, o) {
  const ov = o || {};
  const host = egress.hostOf(url);
  let data = ov.egress === undefined ? null : ov.egress;
  if (!data) {
    try {
      const hosts = new Set(egress.hosts());
      if (host) { await egress.reach(host, ov); hosts.add(host); }
      const read = await probeSection('egress', Object.assign({}, ov, { hosts: [...hosts] }));
      data = (read && read.data) || sectionData('egress');
    } catch { data = sectionData('egress'); }
  }
  const v = coldProfileViable(data, host);
  return Object.assign({}, v, {
    host,
    proxy: data && data.proxy ? data.proxy.state : 'unknown',
    at: data ? data.at || null : null,
  });
}

/** 冷档案隔离窗口的可行性判据（纯函数，与 pickLauncher 同族：分发依据只由表单决定，动作层不自判）。
 *  要判的事：一键登录开的是**独立 user-data-dir 的冷档案**，它没有扩展、没有 per-profile 配置、
 *  没有既有登录态。目标域直连不通时，这个窗口能不能出内容只取决于「机器上有没有一条系统级/环境级代理」：
 *    直连可达            -> 隔离档照开（没有理由砍）；
 *    直连不通 + 代理在    -> 隔离档照开（冷档案继承系统/环境代理，那正是它出网的路）；
 *    直连不通 + 代理明确没有 -> 冷档案必然空白：如实降为并入既有窗口（plain），并交出理由；
 *    任何一环判不出       -> 保持隔离（null）。判不出就砍能力是「用猜到的事实做决定」，同一种病。
 *  返回三态 viable + basis：basis 是给人看的结论码，进 evidence、进面板，绝不只留在日志里。
 *  @param {object|null} eg egress 维度数据（egressData 的产物）；null=尚未探测
 *  @param {string|null} [host] 本次动作的目标主机；没有读数即无从判定
 *  @returns {{viable:boolean|null, basis:string, detail:string}} */
function coldProfileViable(eg, host) {
  if (!eg) return { viable: null, basis: 'egress-unprobed', detail: '出网条件尚未探测，隔离窗口按原档打开' };
  const t = host && eg.targets ? eg.targets[host] : null;
  const reached = t ? t.ok : null;
  const proxyState = eg.proxy ? eg.proxy.state : 'unknown';
  if (reached === true) {
    return { viable: true, basis: 'target-reachable', detail: host + ' 直连可达（' + t.stage + '）' };
  }
  if (reached === null) {
    return { viable: null, basis: 'egress-undetermined', detail: host + ' 的通路判定没有给出答案（' + (t ? t.stage + ' ' + t.detail : '无读数') + '）' };
  }
  if (proxyState === 'on') {
    return { viable: true, basis: 'cold-profile-inherits-proxy', detail: host + ' 直连不通（' + t.stage + '），系统级代理在用，冷档案同一条路' };
  }
  if (proxyState === 'unknown') {
    return { viable: null, basis: 'proxy-unreadable', detail: host + ' 直连不通（' + t.stage + '），但代理读数取不到，按判不出处理' };
  }
  return {
    viable: false, basis: 'cold-profile-blocked',
    detail: host + ' 直连不通（' + t.stage + ' ' + t.detail + '）且系统没有在用代理，冷档案窗口必然空白',
  };
}

/** 表单快照的落盘位置。 */
function snapshotPath() {
  return path.join(stateRoot.supervisorDir(), FILE_NAME);
}

/** 读回上一次落盘的快照（无/坏/版本不符一律 null：快照是给人看的留痕，不是启动依赖）。 */
function readSnapshot() {
  try {
    const doc = JSON.parse(fs.readFileSync(snapshotPath(), 'utf8'));
    return doc && doc.schema === SCHEMA ? doc : null;
  } catch { return null; }
}

/** 上一拍快照的读回口（只读留痕，**绝不参与任何分发判定**：分发只认当场同步装配的 form()）。
 *  存在的理由：快照落了盘却没有任何生产侧读者，就等于「留痕」只是单向写；真机排障要的正是
 *  「上一拍到底探到了什么」，而那可能已经在进程重启后拿不回来了。
 *  available=false 必须分得清是没写过还是读不出：把「读不出」说成「没写过」会引着人去刷新。
 *  @param {{now?:Function}} [o]
 *  @returns {{available:boolean,path:string,at:number|null,ageMs:number|null,reason:string,data:object|null}} */
function lastSnapshot(o) {
  const now = (o && typeof o.now === 'function') ? o.now : Date.now;
  const p = snapshotPath();
  const doc = readSnapshot();
  if (doc) {
    const at = typeof doc.at === 'number' ? doc.at : null;
    return { available: true, path: p, at, ageMs: at === null ? null : Math.max(0, now() - at), reason: 'ok', data: doc };
  }
  return { available: false, path: p, at: null, ageMs: null,
    reason: fs.existsSync(p) ? 'unreadable-or-schema-mismatch' : 'never-written', data: null };
}

let _formCache = null;

/** 环境表单：一次装配出本机全部相关事实。
 *  **同步**是硬要求：选路与执行当场要读它（异步化会把「没探到」变成「等不到」，两者都得各写一套兜底）。
 *  异步维度（出网条件/运行时/DSH）只在此读台账里最近的一拍，从未刷新即 state='pending' —— 如实标未探，
 *  不拿空数据冒充本机实况。要补数据走 refresh()（启动一次 + 面板 ?force=1 + 改偏好后）。
 *  @param {{force?:boolean, persist?:boolean, now?:Function, ttlMs?:number, platform?:string,
 *           inventory?:object, resolveInventory?:Function, resolveDeps?:object}} [o]
 *    persist=true 才落盘（读路径不写盘；面板刷新与启动装配各写一次即可）。
 *  @returns {object} schema/at/identity/paths/session/capabilities/preference/browsers/default/pick/probed/sections/snapshot */
function form(o) {
  const ov = o || {};
  const now = typeof ov.now === 'function' ? ov.now : (() => Date.now());
  const stamp = now();
  const ttl = ov.ttlMs === undefined ? FORM_TTL_MS : ov.ttlMs;
  if (!ov.force && _formCache && stamp - _formCache.at < ttl) {
    return Object.assign({}, _formCache.value, { cached: true });
  }
  const inv = browsers(ov);
  const caps = capabilities();
  const session = desktop.describe();
  const prefId = preferenceId();
  const prefEntry = prefId ? (inv.browsers.find((b) => b.id === prefId) || null) : null;
  const preference = {
    id: prefId,
    configured: !!prefId,
    matched: !!prefEntry,
    browser: prefEntry ? { id: prefEntry.id, name: prefEntry.name, engine: prefEntry.engine } : null,
    reason: !prefId ? 'not-set' : (prefEntry ? 'matched' : 'stale'),
  };
  const pick = pickLauncher(inv.platform, inv, prefId);
  const probed = inv.probed.map((p) => ({ section: 'browsers', source: p.source, detail: p.detail }));
  probed.push({ section: 'session', source: 'desktop', detail: session.reason + (session.available ? '（可用）' : '（不可用）') });
  probed.push({ section: 'capabilities', source: 'profile',
    detail: caps ? 'openBrowser=' + (caps.openBrowser === true) : '未绑定能力矩阵（由 platform/os/index.js 装配期注入）' });
  probed.push({ section: 'preference', source: 'config',
    detail: preference.reason === 'not-set' ? '未设置，按系统默认或候选次序分发'
      : (preference.reason === 'matched' ? '已选 ' + preference.browser.name : '偏好所指已不在候选清单: ' + prefId) });
  probed.push({ section: 'pick', source: 'form',
    detail: pick.how + (pick.browser ? '（' + pick.browser.name + '）' : '（无候选）') + (pick.stale ? '，偏好已失效需重选' : '') });

  // 维度台账：同步维度每拍现装；异步维度取最近一拍，未拍过即 pending（并保留 pending 的说明）。
  const sections = {};
  const syncDims = {
    browsers: { at: stamp, state: inv.browsers.length ? 'ok' : 'empty', count: inv.browsers.length, defaultSource: inv.defaultSource },
    session: { at: stamp, state: session.available ? 'ok' : 'missing', reason: session.reason },
    capabilities: { at: stamp, state: caps ? 'ok' : 'unbound', openBrowser: caps ? caps.openBrowser === true : null },
    preference: { at: stamp, state: preference.reason === 'matched' ? 'ok' : (preference.configured ? 'stale' : 'unset'), id: preference.id },
    pick: { at: stamp, state: pick.browser ? 'ok' : 'empty', how: pick.how, id: pick.browser ? pick.browser.id : null },
  };
  const dimOf = (id) => {
    const def = _sections.get(id);
    const read = _reads.get(id);
    if (read && !syncDims[id]) {
      return { label: def ? def.label : id, at: read.at, source: read.source, state: read.state, data: read.data, error: read.error || null };
    }
    const s = syncDims[id];
    if (s) return Object.assign({ label: id, source: 'self' }, s);
    return { label: def ? def.label : id, at: null, source: def ? def.source : 'registered', state: 'pending', data: null, error: null };
  };
  const ids = SECTION_ORDER.concat([..._sections.keys()].filter((id) => !SECTION_ORDER.includes(id)));
  for (const id of ids) {
    if (sections[id]) continue;
    const entry = dimOf(id);
    sections[id] = entry;
    if (entry.state === 'pending') {
      probed.push({ section: id, source: 'form', detail: '未刷新（等启动装配或面板 force 刷新补拍）' });
    } else if (entry.state === 'error') {
      probed.push({ section: id, source: 'probe', detail: id + ' 探测失败: ' + entry.error });
    }
  }
  const egressRows = ((sections.egress || {}).data || {}).probed || [];
  for (const row of egressRows) probed.push({ section: 'egress', source: row.source, detail: row.detail });
  // shell 维单独留一行结论：读侧只有 sections 而没有这条时，面板折叠处就等于「壳没报过」与「壳报了但
  // 我们没读到」分不清。available 为假要指名是 never-written 还是读不出（后者得去查那个文件）。
  const sh = (sections.shell || {}).data;
  if (sh) {
    probed.push({
      section: 'shell',
      source: 'shell-report:' + (sh.reason || '?'),
      detail: sh.available === true
        ? '壳已上报（写入者 ' + (sh.writtenBy || '未署名') + '，schema ' + sh.schema
          + '，距今 ' + (sh.ageMs === null ? '未读出' : sh.ageMs) + ' 毫秒，明细 ' + (sh.records || []).length + ' 条'
          + (sh.droppedRecords ? '，截断 ' + sh.droppedRecords + ' 条' : '') + '）'
        : (sh.reason === 'never-written' ? '这台机器的壳还没报过（内核独立跑或老版本壳时是常态，不是故障）'
          : '壳报的文件读不出或版本不符，得查：' + (sh.path || '?')),
    });
  }

  const value = {
    schema: SCHEMA,
    at: stamp,
    platform: inv.platform,
    identity: identity(),
    paths: paths(),
    session,
    capabilities: caps,
    preference,
    default: inv.defaultId ? { id: inv.defaultId, source: inv.defaultSource } : null,
    browsers: inv.browsers,
    pick: { how: pick.how, id: pick.browser ? pick.browser.id : null, name: pick.browser ? pick.browser.name : null, wanted: pick.wanted, stale: pick.stale },
    sections,
    probed,
  };
  const snapshot = { path: snapshotPath(), written: false, error: null };
  if (ov.persist === true) {
    try {
      writeAtomic(snapshot.path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      snapshot.written = true;
    } catch (e) { snapshot.error = String((e && e.message) || e); }
    probed.push({ section: 'snapshot', source: FILE_NAME,
      detail: snapshot.written ? '已落盘 ' + snapshot.path : '落盘失败: ' + snapshot.error });
  }
  value.snapshot = snapshot;
  _formCache = { at: stamp, value };
  return Object.assign({ cached: false }, value);
}

/** 显式失效：改动偏好或装卸浏览器后调用。表单缓存与探测层清单一起作废，异步维度只**过期不删数**——
 *  下一拍 refresh 补新值，而面板在这一拍仍看得见上一次读数与其时间；把读数删成 pending 会让人误判
 *  「机器上的浏览器变了」，而那正是本次要探的事。出网读数同理：代理一改，旧判定当场作废。
 *  @param {string} [platform] 探测层清单缓存的平台
 *  @param {string|string[]} [only] 只作废这些维度的读数（不传即全维度过期） */
function invalidate(platform, only) {
  _formCache = null;
  const list = only === undefined ? null : (Array.isArray(only) ? only : [only]);
  if (!list || list.includes('egress')) egress.invalidate();
  for (const id of (list || [..._reads.keys()])) {
    const r = _reads.get(id);
    if (r) r.at = 0;
  }
  return detector.invalidate(platform);
}

/** 偏好校验（纯函数）：空值=清除；非空必须是当前候选清单里的 id，其余一律拒写。
 *  判据住在表单而不住在写入口：它的依据就是这张表的候选面。写入口可以有很多个（面板、CLI、
 *  未来的导入），各自定义「什么算合法偏好」就会各自漂移 —— 与本轮「问一处答两处」同一种病。
 *  @param {*} value 用户提交的原始值（非字符串按空处理，不猜）
 *  @param {object} form 当前环境表单
 *  @returns {{ok:boolean, id:string|null, browser:object|null, error?:string, candidates:object[]}} */
function checkPreference(value, form) {
  const candidates = ((form && form.browsers) || []).map((b) => ({
    id: b.id, name: b.name, engine: b.engine, isDefault: b.isDefault === true,
  }));
  const id = typeof value === 'string' ? value.trim() : '';
  if (!id) return { ok: true, id: null, browser: null, candidates };
  const hit = candidates.find((c) => c.id === id);
  if (!hit) {
    return { ok: false, id: null, browser: null, candidates, error: '该浏览器不在本机候选清单里（可能已卸载或路径失效），请先刷新环境表单' };
  }
  return { ok: true, id: hit.id, browser: hit, candidates };
}

module.exports = {
  SCHEMA, FILE_NAME, FORM_TTL_MS, SECTION_TTL_MS, SECTION_ORDER, SYNC_DIMS,
  bind, preferenceId, capabilities, identity, paths,
  browsers, normalizeInventory, rankCandidates, pickLauncher, checkPreference,
  registerSection, unregisterSection, section, sectionData, refresh,
  coldProfileViable, checkEgress,
  form, snapshotPath, readSnapshot, lastSnapshot, invalidate,
};
