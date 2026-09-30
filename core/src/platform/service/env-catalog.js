'use strict';

const runtime = require('../contract/runtime');

// EnvCatalog：声明式环境目录。每条目 = { id, label, required, probe() -> ok?detail }；
// 状态 ok/outdated/missing/configured/unconfigured。消费方：supervisor.envStatus、面板环境卡。

const ex = require('../util/exec');

/** 探测某二进制版本；不可执行返回 null（经统一执行器）。
 *  args 必随程序同传：契约把 npm 表达成「node + 包内 npm-cli.js」时，只跑 program 读到的是
 *  node 版本号却会被念成 npm 版本 —— 面板据此谎报就绪。 */
function whichVersion(bin, args) {
  const v = ex.runOut(bin, (Array.isArray(args) ? args : []).concat(['--version']), { timeoutMs: 3000 });
  return v ? (v.trim() || null) : null;
}

/** 异步版探测：HTTP 处理路径（envStatus）必须走这条——同步 execFileSync 会在每个
 *  条目上冻结事件循环最长 3s，守卫心跳/自愈停摆（exec.js 同步仅限启动早期与 CLI）。 */
function whichVersionAsync(bin, args) {
  return ex.runOutAsync(bin, (Array.isArray(args) ? args : []).concat(['--version']), { timeoutMs: 3000 })
    .then((v) => (v ? (v.trim() || null) : null));
}

// 版本探测缓存（TTL 10s）：envStatus 的 probe + summary 单次调用内重复探测 3+ 次，
// 每次都是同步 execFileSync，占进程/磁盘且阻塞事件循环。键必须带上 args：
// 同一程序配不同前缀参数是两个不同的被探测物。
const _verCache = new Map();
const CACHE_TTL = 10000;
function cacheKey(bin, args) {
  const a = Array.isArray(args) ? args : [];
  return bin + '\u0000' + a.join('\u0000');
}
function cacheSet(key, v) {
  _verCache.set(key, { at: Date.now(), v });
  if (_verCache.size > 16) { // 有界：清最旧
    let oldest = null;
    for (const [k, e] of _verCache) if (!oldest || e.at < oldest.at) oldest = { k, at: e.at };
    if (oldest) _verCache.delete(oldest.k);
  }
  return v;
}
function cachedWhichVersion(bin, args) {
  const key = cacheKey(bin, args);
  const hit = _verCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_TTL) return hit.v;
  return cacheSet(key, whichVersion(bin, args));
}
function cachedWhichVersionAsync(bin, args) {
  const key = cacheKey(bin, args);
  const hit = _verCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return Promise.resolve(hit.v);
  return whichVersionAsync(bin, args).then((v) => cacheSet(key, v));
}

/** Node 最低版本门槛兜底（契约不可用时）。必须与壳的 node.rs MIN_NODE 一致，否则面板说
 *  环境就绪而壳拒绝启动内核；真实取值由壳经 <产品状态根>/supervisor/runtime.json 的 minNode 投放。 */
const MIN_NODE_DEFAULT = 'v22.12.0';

/** 读取壳投放的运行时元数据；单一事实源：共用 platform/contract/runtime（壳写、内核读）。 */
let _runtimeMetaCache = null;
let _runtimeMetaAt = 0;
function runtimeMeta() {
  const now = Date.now();
  if (_runtimeMetaCache && now - _runtimeMetaAt < 10000) return _runtimeMetaCache;
  const c = runtime.read();
  const meta = (c && c.raw) || {};
  _runtimeMetaCache = meta;
  _runtimeMetaAt = now;
  return meta;
}

/** 解析形如 v22.12.0 / 22.12.0 的版本为数字数组（非数字段记 0）。 */
function parseVer(v) {
  return String(v).replace(/^v/i, '').split('-')[0].split('.').map((x) => parseInt(x, 10) || 0);
}

/** a >= b（段数不同时缺位补 0）。 */
function verAtLeast(a, b) {
  const A = parseVer(a); const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0; const y = B[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Node 门槛判定：不仅要能执行，还要达到最低门槛（低于门槛判 outdated，壳会拒绝启动该内核）。
 *  同步/异步两条探测路径共用本判定（分叉=两份口径）。 */
function nodeVerdict(v) {
  if (!v) return null;
  // `node --version` 输出形如 v22.12.0；取第一个 vX.Y.Z 片段。
  const m = /v?(\d+\.\d+\.\d+)/.exec(String(v));
  const ver = m ? m[1] : String(v).trim();
  const min = String(runtimeMeta().minNode || MIN_NODE_DEFAULT);
  return { version: 'v' + ver, min, meets: verAtLeast(ver, min) };
}
function probeNode() {
  return nodeVerdict(cachedWhichVersion('node'));
}
function probeNodeAsync() {
  return cachedWhichVersionAsync('node').then(nodeVerdict);
}

/** npm 探测：只经统一启动形态解析口（契约优先，缺席退回 os/exec-path 的 PATHEXT 解析）。
 *  不得退回裸 'npm'（npm-resolution 门禁禁止）：Windows 上 npm 实为 npm.cmd，Node 不做
 *  PATHEXT 解析，裸名会把已装误报 missing。契约在场但指向文件跑不通同样如实报 missing。 */
function probeNpm() {
  const l = runtime.npmLauncher();
  return cachedWhichVersion(l.program, l.args);
}
function probeNpmAsync() {
  const l = runtime.npmLauncher();
  return cachedWhichVersionAsync(l.program, l.args);
}

/** 系统环境条目（Node/npm 为 DSH 与反代更新的执行器；git 可选）。probe=同步口径（启动早期/CLI），
 *  probeAsync=事件循环敏感路径口径；两条必须同语义（同一判定/解析口）。 */
const SYSTEM_ENTRIES = {
  node: { label: 'Node.js', required: true, probe: probeNode, probeAsync: probeNodeAsync },
  npm:  { label: 'npm',     required: true, probe: probeNpm, probeAsync: probeNpmAsync },
  git:  { label: 'git',     required: false, probe: () => cachedWhichVersion('git'), probeAsync: () => cachedWhichVersionAsync('git') },
};

/** 探测值 -> 条目视图。state 三态：ok = 存在且满足门槛（Node 需 >= 壳投放的 minNode）；
 *  outdated = 存在但低于门槛；missing = 不存在。
 *  兼容：detail 保持字符串，新增字段（version/min/meets）放 detail 之外，不破坏既有契约。 */
function entryView(id, e, v) {
  if (v && typeof v === 'object' && typeof v.meets === 'boolean') {
    return {
      label: e.label, required: e.required,
      state: v.meets ? 'ok' : 'outdated',
      version: v.version, min: v.min, meets: v.meets,
      detail: v.meets ? v.version : (v.version + '（低于最低要求 ' + v.min + '）'),
    };
  }
  return { label: e.label, required: e.required, state: v ? 'ok' : 'missing', detail: v };
}

class EnvCatalog {
  constructor(config) { this.config = config || {}; }

  /** 系统二进制条目探测（同步口径）：{ id: 条目视图 }。仅限启动早期/CLI；HTTP 路径用 probeAsync。 */
  probe() {
    const out = {};
    for (const [id, e] of Object.entries(SYSTEM_ENTRIES)) {
      out[id] = entryView(id, e, e.probe() || null);
    }
    return out;
  }

  /** 异步口径：条目并行探测（最坏 3s x N 的串行冻结 -> 全程不阻塞事件循环）。 */
  async probeAsync() {
    const entries = Object.entries(SYSTEM_ENTRIES);
    const vals = await Promise.all(entries.map(([, e]) => e.probeAsync()));
    const out = {};
    entries.forEach(([id, e], i) => { out[id] = entryView(id, e, vals[i] || null); });
    return out;
  }

/** 内核更新依赖条目（单写入者契约：安装/重启归桌面壳，守卫只读 corePackageName 查版本状态）。
 *  id 仍为 selfUpdate 以兼容既有 /env/status 消费方。 */
  selfUpdateEntry() {
    const pkg = this.config.corePackageName;
    if (!pkg) {
      return {
        label: '内核更新（桌面壳执行）',
        required: false,
        state: 'unconfigured',
        detail: '未配置 corePackageName（形如 @dsh-sup/dsh-core-<os>-<arch>）',
      };
    }
    return { label: '内核更新（桌面壳执行）', required: false, state: 'configured', detail: pkg };
  }

  /** DSH 本体条目（外传判定：bin 可执行 + 已装版本）。 */
  dshEntry(binOk, installed, bin) {
    return {
      label: 'DSH 本体',
      required: true,
      state: binOk ? 'ok' : 'missing',
      detail: binOk ? (installed || '已装') : ('bin 不存在: ' + (bin || '?')),
    };
  }

/** 汇总：全部必填项状态（供面板/守卫快速判定环境就绪）；无 sys 时探测一次（有 10s TTL 缓存）。 */
  summary(extra, sys) {
    const s = sys || this.probe();
    const items = { ...s, ...(extra || {}) };
    const required = Object.values(items).filter((e) => e && e.required);
    return { ready: required.every((e) => e.state === 'ok' || e.state === 'configured'), items };
  }
}

module.exports = { EnvCatalog };
