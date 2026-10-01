'use strict';

const { getJson, getText } = require('./market-net');
const ref = require('../../platform/distribution/registry-ref');

const RAW_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/'];

async function rawGet(pathPart, isJson, timeoutMs = 15000) {
  const direct = 'https://raw.githubusercontent.com/' + pathPart;
  const tryOne = (url) => isJson
    ? getJson(url, timeoutMs).then((d) => ({ ok: true, data: d }), () => ({ ok: false }))
    : getText(url, timeoutMs).then((d) => ({ ok: true, data: d }), () => ({ ok: false }));
  let r = await tryOne(direct);
  if (r.ok) return r.data;
  for (const mir of RAW_MIRRORS) {
    r = await tryOne(mir + direct);
    if (r.ok) return r.data;
  }
  throw new Error('raw fetch failed for ' + pathPart);
}

async function fetchLatest(origin, name) {
  const url = ref.registryUrl(origin, ref.registryPackagePath(name), 'latest');
  if (!url) return null;
  const r = await ref.fetchRegistry(url, { timeoutMs: 8000, expect: 'json' });
  return r.ok ? r.json : null;
}

async function repoPkg(fullName) {
  for (const branch of ['master', 'main']) {
    try { return await rawGet(fullName + '/' + branch + '/package.json', true, 8000); } catch {}
  }
  return null;
}

module.exports = { rawGet, fetchLatest, repoPkg };
