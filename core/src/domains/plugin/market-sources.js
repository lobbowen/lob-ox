'use strict';

// 插件市场源抓取叶子原语（无预算状态）：rawGet / fetchLatest / repoPkg + RAW_MIRRORS。
// 批次循环必须留在 market.js（test/market-budget-test.js M-d 以源码正则锁定预算检查在 slice 之前）。

const { getJson, getText } = require('./market-net');
// 镜像基址的形态与传输走 platform/distribution/registry-ref 单口：市场查询与内核取包元数据
// 必须对同一个源得到同一个答案（第二套 HTTP 就会长出第二套「可达」判据）。
const ref = require('../../platform/distribution/registry-ref');

/** raw.githubusercontent.com 镜像回退：该域名在部分网络不可达会导致 github/community
 *  整源失败；先直连 raw，失败/超时再走 gh-proxy 镜像。 */
const RAW_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/'];

/** 抓 raw 内容（JSON 或文本），直连失败走镜像。 */
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

/** npm 最新版元数据查询（origin 由调用方经 dist 统一镜像源选择）。基址非法即返回 null，
 *  不拼一个必败 URL。 */
async function fetchLatest(origin, name) {
  const url = ref.registryUrl(origin, ref.registryPackagePath(name), 'latest');
  if (!url) return null;
  const r = await ref.fetchRegistry(url, { timeoutMs: 8000, expect: 'json' });
  return r.ok ? r.json : null;
}

/** 抓取 GitHub 仓库 package.json（raw）验证 dsh.bundle。 */
async function repoPkg(fullName) {
  for (const branch of ['master', 'main']) {
    try { return await rawGet(fullName + '/' + branch + '/package.json', true, 8000); } catch {}
  }
  return null;
}

module.exports = { rawGet, fetchLatest, repoPkg };
