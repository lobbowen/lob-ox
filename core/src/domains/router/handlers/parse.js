'use strict';

// 纯解析层（无 IO、无 this，不 require node:fs/net/child_process）：URL/请求映射 + 用量解析 + 费用估算 + 目标解析。

/** 上游 URL 拼接：base + 请求路径（去重 /v1）+ 原始 query。 */
function joinUpstream(base, reqPath, rawQuery) {
  const u = new URL(base);
  let p = reqPath;
  const trimmed = u.pathname.replace(/\/+$/, '');
  if (p.startsWith('/v1') && (trimmed === '/v1' || trimmed.endsWith('/v1'))) p = p.slice(3);
  u.pathname = trimmed + '/' + p.replace(/^\/+/, '');
  u.search = rawQuery || '';
  return u.toString();
}

/** 从响应文本提取 usage（扫所有 "usage" 对象，取 total_tokens 最大者）。 */
function extractUsage(text) {
  if (!text) return null;
  let searchFrom = 0, best = null;
  while (true) {
    const usageKey = text.indexOf('"usage"', searchFrom);
    if (usageKey === -1) break;
    const after = text.slice(usageKey + 8);
    if (!after.trimStart().startsWith('{')) { searchFrom = usageKey + 8; continue; }
    const start = text.indexOf('{', usageKey);
    if (start === -1) break;
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
    if (end === -1) break;
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      if (obj && typeof obj === 'object' && (obj.prompt_tokens !== undefined || obj.total_tokens !== undefined)) {
        const promptTokens = Number(obj.prompt_tokens) || 0;
        const completionTokens = Number(obj.completion_tokens) || 0;
        let totalTokens = Number(obj.total_tokens) || 0;
        if (!totalTokens) totalTokens = promptTokens + completionTokens;
        const cacheHit = Number(obj.prompt_cache_hit_tokens) || Number(obj.prompt_tokens_details && obj.prompt_tokens_details.cached_tokens) || 0;
        const cacheMiss = Number(obj.prompt_cache_miss_tokens) || Math.max(0, promptTokens - cacheHit);
        if (!best || (obj.total_tokens || 0) > (best.totalTokens || 0)) best = { promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss };
      }
    } catch {}
    searchFrom = usageKey + 8;
  }
  return best;
}

/** 按 models.dev 单价估算一次调用费用（$）。单价缺失/未知模型则为 0（不虚报）。
 *  模型名归一化：带供应商前缀（deepseek/deepseek-v4-flash）时去前缀查索引。 */
function estimateCost(entry) {
  const pricing = entry && entry.pricing;
  if (!pricing || typeof pricing !== 'object') return 0;
  let pr = pricing[entry.model];
  if (!pr || typeof pr !== 'object') {
    const slash = String(entry.model || '').indexOf('/');
    const bare = slash > 0 ? String(entry.model).slice(slash + 1) : null;
    if (bare) pr = pricing[bare];
  }
  if (!pr || typeof pr !== 'object') return 0;
  const input = Number(pr.input) || 0;
  const output = Number(pr.output) || 0;
  const pt = Number(entry.promptTokens) || 0;
  const ct = Number(entry.completionTokens) || 0;
  if (!pt && !ct) return 0;
  return (pt / 1e6) * input + (ct / 1e6) * output;
}

/** 实例的唯一解析入口：有池能力时走 prov.instanceOf(acc)，否则回退内联 acc.instance 引用。 */
function instOf(prov, acc) {
  if (!acc) return null;
  if (prov && prov.supports && prov.supports('instanceLifecycle')) {
    try { return prov.instanceOf(acc) || null; } catch { /* 回退到内联引用 */ }
  }
  return acc.instance || null;
}

/** 账号/实例目标：{ targetBase, prov }（直连=baseUrl，反代=实例端口）。不跨池。 */
function resolveTarget(acc, prov) {
  if (!prov) return null;
  if (prov.supports && prov.supports('instanceLifecycle')) {
    const inst = instOf(prov, acc);
    if (!inst || !inst.port) return null;
    return { targetBase: 'http://127.0.0.1:' + inst.port, prov };
  }
  return { targetBase: (prov.baseUrl || '').replace(/\/+$/, ''), prov };
}

/** 请求映射：解析 URL（按供应商 apiPort 补 base）+ body 中的 model/stream 标记。纯。 */
function parseRequest(req, apiPort, bodyBuf) {
  const u = new URL(req.url, 'http://127.0.0.1:' + (apiPort || 0));
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyBuf.toString('utf8')); } catch {}
  const model = (bodyJson && typeof bodyJson.model === 'string') ? bodyJson.model : 'unknown';
  const streamRequested = !!(bodyJson && bodyJson.stream === true);
  return { pathname: u.pathname, search: u.search, model, streamRequested, bodyJson };
}

/** 有界读取请求体（100MB 上限），无 this。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 104857600) { reject(new Error('body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { parseRequest, extractUsage, resolveTarget, joinUpstream, estimateCost, instOf, readBody };
