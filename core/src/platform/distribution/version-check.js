'use strict';

// 包目标版本查询（IO）：回答「这个包该装哪个版本、这个版本是从哪个镜像取到的、取不到的话每个镜像为什么不行」。
// 与 install.js（npm 执行）分开：查询是纯读取且必须按候选镜像顺延，执行是一次性副作用；
// 两者混在一起时「取不到版本」会被显示成「已是最新」，正是面板表现为「完全获取不到最新版本」的那一段。

const { VERSION_RE } = require('../../shared/version');
const input = require('../util/input');
const policies = require('./policies');
const registry = require('./registry');
const ref = require('./registry-ref');
const release = require('./release');

// 字符集白名单尺子取自 platform/util/input 单源（与 install.js 同一把尺，不复制正则字面量）。
const PKG_NAME_RE = input.PKG_NAME_RE;

/** 单次包元数据查询的时长上界。候选全部顺延一遍的最坏耗时约为候选数与本值的乘积；排在前面的是刚
 *  测速可达的源，走到最后一个通常意味着网络本身有问题 —— 那时「指名哪个源为什么失败」比早退更有用。 */
const METADATA_TIMEOUT_MS = 8000;

/** 一次取版本的总时长预算。候选无限顺延会让面板请求挂住（6 个镜像各跑两次 8s 查询就是分钟级），
 *  而「取不到」本身必须如实上报而不是等下去 —— 超预算时剩余候选记为未尝试，不伪装成逐源失败。 */
const FETCH_BUDGET_MS = 25000;

/** 一个源上该包的目标版本。@returns {{version:string|null, error:string|null}} */
async function versionFromOrigin(state, base, pkg) {
  const url = ref.registryUrl(base, ref.registryPackagePath(pkg));
  const res = await ref.fetchRegistry(url, { timeoutMs: METADATA_TIMEOUT_MS, expect: 'json' });
  if (!res.ok) return { version: null, error: res.error || ('HTTP ' + res.status) };
  const picked = release.pickReleaseVersion(res.json, {
    isOurs: release.isOurReleasePackage(pkg),
    canary: policies.isInCanaryList(state), // 仅 isOurs 分支消费
    isValid: (v) => typeof v === 'string' && VERSION_RE.test(v),
  });
  if (picked) return { version: picked, error: null };
  // 元数据里没有任何可用版本（有的镜像只代理 latest 端点）—— 属「版本缺失」而非「通道选择」，
  // 与选版算法无关，故留在这里而不是塞进 release.js。
  const lr = await ref.fetchRegistry(ref.registryUrl(base, ref.registryPackagePath(pkg), 'latest'),
    { timeoutMs: METADATA_TIMEOUT_MS, expect: 'json' });
  if (!lr.ok) return { version: null, error: lr.error || ('HTTP ' + lr.status) };
  const v = (lr.json && typeof lr.json.version === 'string' && VERSION_RE.test(lr.json.version)) ? lr.json.version : null;
  return { version: v, error: v ? null : '元数据无可用版本' };
}

/** 取「我们的包/第三方包」的目标版本，按候选镜像**顺延**（探测可达却取不到字节，正是
 *  面板表现为「完全获取不到最新版本」的那一段：单源失败即整体判负）。
 *  @returns {Promise<{ok:boolean, version:string|null, origin:string|null, attempts:Array<{origin:string,error:string}>, error:string|null}>}
 *  返回结构而不是版本字符串：只回 null 时调用方无法区分「确实没有更新」与「镜像源取不到」，
 *  UI 就把取失败显示成「已是最新」；origin 必须回传，下载要用**给出这个版本的那个源**，
 *  否则「显示一个源、下载另一个源」的分叉会回来。 */
async function fetchNpmLatest(state, pkg, opts) {
  const o = opts || {};
  const fail = (error, attempts) => ({ ok: false, version: null, origin: null, attempts: attempts || [], error });
  if (!pkg) return fail('缺少包名');
  // 拉元数据前过基址形态闸（在候选构造里）与包名白名单：manualOrigin/契约 selected 等来路不经
  // setRegistryConfig 校验，URL 拼接攻击面只能在这里堵。
  if (!PKG_NAME_RE.test(pkg)) return fail('非法包名（字符集白名单不通过）: ' + String(pkg).slice(0, 80));

  let candidates = [];
  if (o.authoritative) {
    // 发布权威源解析：版本真相源 = 官方 npm registry。镜像同步有延迟，把「镜像未同步」
    // 误判为「没有新版本」是真相源错误 —— 故只要候选里有官方源就只问它，取不到也**不**去镜像
    // 顺延拿一个陈旧版本（RC-G8-a/b）。一条官方源都没有（企业内网代理形态）才退回列表首项，
    // 并把实际使用的源如实回传，兜底不留暗账（RC-G8-c）。
    // registryOrigins 会保留形态非法的条目（供 UI 指名），消费侧必须自己滤掉。
    const list = registry.registryOrigins(state).filter((x) => ref.parseRegistryBase(x).ok);
    candidates = list.filter((x) => /registry\.npmjs\.org/.test(x));
    if (!candidates.length && list.length) candidates = [list[0]];
  } else {
    const sel = await registry.selectRegistry(state, false);
    candidates = (sel && sel.ordered) || [];
  }
  if (!candidates.length) return fail('无可用的镜像源候选（全部基址非法或列表为空）');

  const attempts = [];
  const deadline = Date.now() + FETCH_BUDGET_MS;
  for (let i = 0; i < candidates.length; i++) {
    if (i && Date.now() >= deadline) {
      attempts.push({ origin: candidates.slice(i).join(','), error: '未尝试（超出 ' + Math.round(FETCH_BUDGET_MS / 1000) + 's 总预算）' });
      break;
    }
    const base = candidates[i];
    const r = await versionFromOrigin(state, base, pkg);
    if (r.version) return { ok: true, version: r.version, origin: base, attempts, error: null };
    attempts.push({ origin: base, error: r.error || '未取到版本' });
  }
  return fail('全部镜像未取到 ' + pkg + ' 的版本：' + attempts.map((a) => a.origin + '=' + a.error).join('; '), attempts);
}

/** GitHub Releases 最新 tag（去除可选 v 前缀）。返回版本号。 */
async function fetchGithubLatest(owner, repo) {
  if (!owner || !repo) return null;
  try {
    const res = await fetch(
      'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest',
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'dsh-supervisor' } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const tag = (j && typeof j.tag_name === 'string') ? j.tag_name : (j && typeof j.name === 'string' ? j.name : null);
    if (!tag) return null;
    return String(tag).replace(/^v/, '');
  } catch (e) { return null; }
}

/** 统一版本检查（结构化）：channel = 'npm' | 'github'。
 *  @returns {Promise<{ok:boolean, version:string|null, origin:string|null, attempts:Array, error:string|null}>}
 *  需要「这个版本从哪个源来」的调用方走这里；只要版本字符串的走 fetchLatestVersion。
 *  github 通道的 origin 恒为 null —— 那是事实（它不经 registry），不是失败降级。 */
async function fetchVersionInfo(state, pkg, channel, opts) {
  const ch = channel || 'npm';
  const o = opts || {};
  if (ch === 'github') {
    const slash = String(pkg).split('/');
    const version = slash.length >= 2 ? await fetchGithubLatest(slash[0], slash.slice(1).join('/')) : null;
    return {
      ok: !!version, version: version || null, origin: null, attempts: [],
      error: version ? null : 'GitHub Releases 未查询到 ' + pkg + ' 的最新版',
    };
  }
  return fetchNpmLatest(state, pkg, { authoritative: o.authoritative === true });
}

/** 统一版本检查：channel = 'npm' | 'github'。返回最新版本字符串或 null。
 *  只要「版本号」的调用方走这里；需要失败原因或下载源的调用方走 fetchVersionInfo。
 *  @param {object} [opts] { authoritative?: boolean } */
async function fetchLatestVersion(state, pkg, channel, opts) {
  const r = await fetchVersionInfo(state, pkg, channel, opts);
  return r.ok ? r.version : null;
}

module.exports = {
  METADATA_TIMEOUT_MS,
  FETCH_BUDGET_MS,
  fetchNpmLatest,
  fetchVersionInfo,
  fetchLatestVersion,
};
