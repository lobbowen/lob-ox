'use strict';

const { VERSION_RE } = require('../../shared/version');
const input = require('../util/input');
const policies = require('./policies');
const registry = require('./registry');
const ref = require('./registry-ref');
const release = require('./release');

const PKG_NAME_RE = input.PKG_NAME_RE;

const METADATA_TIMEOUT_MS = 8000;

const FETCH_BUDGET_MS = 25000;

async function versionFromOrigin(state, base, pkg) {
  const url = ref.registryUrl(base, ref.registryPackagePath(pkg));
  const res = await ref.fetchRegistry(url, { timeoutMs: METADATA_TIMEOUT_MS, expect: 'json' });
  if (!res.ok) return { version: null, error: res.error || ('HTTP ' + res.status) };
  const picked = release.pickReleaseVersion(res.json, {
    isOurs: release.isOurReleasePackage(pkg),
    canary: policies.isInCanaryList(state),
    isValid: (v) => typeof v === 'string' && VERSION_RE.test(v),
  });
  if (picked) return { version: picked, error: null };
  const lr = await ref.fetchRegistry(ref.registryUrl(base, ref.registryPackagePath(pkg), 'latest'),
    { timeoutMs: METADATA_TIMEOUT_MS, expect: 'json' });
  if (!lr.ok) return { version: null, error: lr.error || ('HTTP ' + lr.status) };
  const v = (lr.json && typeof lr.json.version === 'string' && VERSION_RE.test(lr.json.version)) ? lr.json.version : null;
  return { version: v, error: v ? null : '元数据无可用版本' };
}

async function fetchNpmLatest(state, pkg, opts) {
  const o = opts || {};
  const fail = (error, attempts) => ({ ok: false, version: null, origin: null, attempts: attempts || [], error });
  if (!pkg) return fail('缺少包名');
  if (!PKG_NAME_RE.test(pkg)) return fail('非法包名（字符集白名单不通过）: ' + String(pkg).slice(0, 80));

  let candidates = [];
  if (o.authoritative) {
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

async function fetchGithubLatest(owner, repo) {
  if (!owner || !repo) return null;
  try {
    const res = await fetch(
      'https://api.github.com/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/releases/latest',
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'lobox' } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const tag = (j && typeof j.tag_name === 'string') ? j.tag_name : (j && typeof j.name === 'string' ? j.name : null);
    if (!tag) return null;
    return String(tag).replace(/^v/, '');
  } catch (e) { return null; }
}

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
