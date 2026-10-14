'use strict';

const path = require('node:path');
const { getJson } = require('./market-net');
const { rawGet, fetchLatest, repoPkg } = require('./market-sources');
const { classify, pickAuthor } = require('./policies/classify');
const marketCache = require('./store/market-cache');
const { npmEntry, githubEntry } = require('./policies/market-entry');

const REGISTRY = 'https://registry.npmjs.org';
const GH_API = 'https://api.github.com';
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const INDEX_FILE = 'plugin-market-cache.json';

async function addCommunityLink(host, { npmName, ghName, label }, out, seenName) {
  try {
    if (npmName) {
      const meta = await host.safeFetchLatest(npmName);
      if (meta && meta.dsh && meta.dsh.bundle && !seenName.has(npmName)) {
        seenName.add(npmName);
        out.push({ name: npmName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: pickAuthor(meta), homepage: meta.homepage || null, repository: meta.repository && meta.repository.url || null, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
      }
    } else if (ghName) {
      const meta = await host.safeRepoPkg(ghName);
      if (meta && meta.dsh && meta.dsh.bundle && !seenName.has(ghName)) {
        seenName.add(ghName);
        out.push({ name: meta.name || ghName, version: meta.version || null, description: (meta.description || label || '').slice(0, 200), author: ghName.split('/')[0], homepage: null, repository: 'https://github.com/' + ghName, keywords: meta.keywords || [], stars: 0, source: 'community', hasBundle: true });
      }
    }
  } catch {  }
}

class PluginMarket {
  constructor(opts) {
    this.cacheDir = opts.cacheDir || path.dirname(opts.stateFile || '');
    this.stateFile = opts.stateFile;
    this.ttl = opts.ttlMs || DEFAULT_TTL_MS;
    this.logger = opts.logger || console;
    this.dist = opts.dist || null;
    this.indexFile = path.join(this.cacheDir, INDEX_FILE);
    this._cache = null;
    this._ts = 0;
    this._inFlight = null;
    this._lastError = null;
    this._nextAllowAt = 0;
    
    this.retryBackoffMs = opts.retryBackoffMs || 60000;
    this.buildBudgetMs = opts.buildBudgetMs || 240000;
    this.loadFromDisk();
  }

  loadFromDisk() {
    const r = marketCache.loadIndex(this.indexFile);
    if (!r) return false;
    this._cache = r.cache;
    this._ts = r.ts;
    return true;
  }

  saveToDisk() { marketCache.saveIndex(this.cacheDir, this.indexFile, this._cache, this.logger); }

  getIndex(force = false) {
    const need = !this._cache || force || Date.now() - this._ts >= this.ttl;
    if (need && (force || Date.now() >= this._nextAllowAt)) this._requestBuild();
    return Promise.resolve(this._view());
  }

  _view() {
    const c = this._cache;
    return {
      ok: true,
      indexedAt: c ? c.indexedAt : 0,
      sources: c ? c.sources : { npm: 0, github: 0, community: 0 },
      total: c ? c.total : 0,
      plugins: c ? c.plugins : [],
      building: !!this._inFlight,
      error: this._lastError,
    };
  }

  _requestBuild() {
    if (this._inFlight) return this._inFlight;
    const raw = this.buildIndex();
    raw.catch(() => {});
    this._inFlight = raw;
    raw.then(
      () => { this._lastError = null; },
      (e) => {
        this._lastError = (e && e.message) || String(e);
        
        
        
        this._nextAllowAt = Date.now() + this.retryBackoffMs;
        this.logger.warn && this.logger.warn('market: 索引构建失败（沿用旧缓存）: ' + this._lastError);
      }
    ).then(() => { if (this._inFlight === raw) this._inFlight = null; });
    return raw;
  }

  async buildIndex() {
    const start = Date.now();
    const bctx = { deadline: start + this.buildBudgetMs, truncated: new Set() };
    try { return await this._buildIndexInner(start, bctx); }
    finally { bctx.deadline = 0; }
  }

  _budgetExhausted(bctx) { return !!bctx && bctx.deadline > 0 && Date.now() >= bctx.deadline; }

  async _buildIndexInner(start, bctx) {
    const plugins = [];
    const seen = new Set();
    const add = (p) => {
      if (!p || seen.has(p.name)) return;
      seen.add(p.name);
      plugins.push(p);
    };

    const npm = await this.indexNpm(bctx);
    npm.forEach(add);

    const gh = await this.indexGithub(bctx);
    gh.forEach(add);

    const community = await this.indexCommunity(bctx);
    community.forEach(add);

    for (const p of plugins) {
      p.category = p.category || classify(p);
      p.stars = p.stars || 0;
    }
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    const prev = this._cache;

    const truncated = bctx.truncated;
    if (prev && prev.plugins && prev.plugins.length > 0 && truncated.size > 0) {
      const freshNames = new Set(plugins.map((pp) => pp.name));
      const kept = prev.plugins.filter((pp) => truncated.has(pp.source) && !freshNames.has(pp.name));
      for (const kp of kept) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      if (kept.length) {
        this.logger.warn && this.logger.warn(
          'market: 源 ' + [...truncated].join('/') + ' 因预算截断，已与旧缓存合并（补回 ' + kept.length + ' 条）'
        );
      }
    }

    if (prev && prev.plugins && prev.plugins.length > 0 && plugins.length < prev.plugins.length * 0.5) {
      const freshSources = new Set(plugins.map((pp) => pp.source));
      const keepPrev = prev.plugins.filter((pp) => !freshSources.has(pp.source));
      for (const kp of keepPrev) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      this.logger.warn && this.logger.warn('market index partial build: ' + plugins.length + ' (prev ' + prev.plugins.length + ') — 失败源已沿用旧缓存');
    }

    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    this._cache = { indexedAt: Date.now(), sources: { npm: npm.length, github: gh.length, community: community.length }, total: plugins.length, plugins };
    this._ts = Date.now();
    this.saveToDisk();
    this.logger.info && this.logger.info('market index built in ' + (Date.now() - start) + 'ms: ' + plugins.length + ' plugins (npm=' + npm.length + ', gh=' + gh.length + ', community=' + community.length + ')');
    return this._cache;
  }

  async indexNpm(bctx) {
    const out = [];
    const queries = ['keywords:deepseek-harness', 'keywords:dsh-bundle', 'keywords:dsh-plugin'];
    const allNames = new Set();
    for (const query of queries) {
      try {
        for (let from = 0; from < 1000; from += 250) {
          const base = await this._npmOrigin();
          const url = base + '/-/v1/search?text=' + encodeURIComponent(query) + '&size=250&from=' + from;
          let d;
          try { d = await getJson(url, 15000); } catch { break; }
          const items = d.objects || [];
          for (const o of items) allNames.add(o.package.name);
          if (items.length < 250) break;
        }
      } catch (e) { this.logger.error && this.logger.error('npm search fail ' + query + ': ' + e.message); }
    }
    const names = [...allNames];
    this.logger.info && this.logger.info('npm candidates: ' + names.length);
    const batch = 8;
    for (let i = 0; i < names.length; i += batch) {
      if (this._budgetExhausted(bctx)) { bctx.truncated.add("npm"); this.logger.warn && this.logger.warn("market: npm 源预算耗尽，已处理 " + i + "/" + names.length + " 个候选"); break; }
      const slice = names.slice(i, i + batch);
      await Promise.all(slice.map(async (name) => {
        const meta = await this.safeFetchLatest(name);
        if (meta && meta.dsh && meta.dsh.bundle) {
          out.push(npmEntry(name, meta));
        }
      }));
    }
    return out;
  }
  async _npmOrigin() {
    let origin = null;
    if (this.dist) { try { origin = await this.dist.registryOrigin(false); } catch {} }
    return origin || REGISTRY;
  }

  async safeFetchLatest(name) {
    return fetchLatest(await this._npmOrigin(), name);
  }

  async indexGithub(bctx) {
    const out = [];
    const topics = ['dsh-plugin', 'deepseek-harness'];
    const seen = new Set();
    for (const topic of topics) {
      try {
        const url = GH_API + '/search/repositories?q=topic:' + topic + '&sort=stars&order=desc&per_page=30';
        const d = await getJson(url, 12000);
        for (const r of (d.items || [])) {
          if (seen.has(r.full_name)) continue;
          seen.add(r.full_name);
          const text = (r.full_name + ' ' + (r.description || '')).toLowerCase();
          if (!text.includes('dsh') && !text.includes('deepseek-harness') && !text.includes('deepseek harness')) continue;
          if (r.full_name === 'deepseek-ai/deepseek-harness') continue;
          const meta = await this.safeRepoPkg(r.full_name);
          if (meta && meta.dsh && meta.dsh.bundle) {
            out.push(githubEntry(meta, r));
          }
        }
      } catch (e) { this.logger.error && this.logger.error('github index fail ' + topic + ': ' + e.message); }
    }
    return out;
  }

  async safeRepoPkg(fullName) {
    return repoPkg(fullName);
  }

  async indexCommunity(bctx) {
    const out = [];
    try {
      const md = await rawGet('awesome-dsh-plugin/awesome-dsh-plugin/main/README.md', false, 30000);
      const re = /\[([^\]|]+)\]\(https:\/\/(?:www\.)?(?:npmjs\.com\/package\/([\w@\/.-]+)|github\.com\/([\w.-]+\/[\w.-]+))\)/g;
      const links = [];
      let m;
      while ((m = re.exec(md)) !== null) { links.push({ npmName: m[2], ghName: m[3], label: m[1] || '' }); }
      const seenName = new Set();
      for (let i = 0; i < links.length; i += 8) {
        if (this._budgetExhausted(bctx)) { bctx.truncated.add("community"); this.logger.warn && this.logger.warn("market: community 源预算耗尽，已处理 " + i + "/" + links.length + " 个候选"); break; }
        const slice = links.slice(i, i + 8);
        await Promise.all(slice.map((link) => addCommunityLink(this, link, out, seenName)));
      }
    } catch (e) { this.logger.error && this.logger.error('community index fail: ' + e.message); }
    return out;
  }
}

module.exports = { PluginMarket };
