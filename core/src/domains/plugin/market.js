'use strict';

// 插件市场索引服务：实时聚合 npm + GitHub 的 DeepSeek Harness 插件；权威判定 = 包/仓库声明 dsh.bundle；
// 分类基于 keywords + 描述启发；来源标注 npm/github/community；磁盘缓存 + TTL 刷新。
// HTTP 原语在 market-net.js、源叶子在 market-sources.js；批次循环体必须留在本文件（test/market-budget-test.js M-d 以源码正则锁定「预算检查在 slice 之前」）。

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

/** 社区源单条候选处理（单条失败跳过，不影响整体）。 */
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
  } catch { /* 单条失败跳过，不影响整体 */ }
}

class PluginMarket {
  constructor(opts) {
    this.cacheDir = opts.cacheDir || path.dirname(opts.stateFile || '');
    this.stateFile = opts.stateFile;
    this.ttl = opts.ttlMs || DEFAULT_TTL_MS;
    this.logger = opts.logger || console;
    this.dist = opts.dist || null;   // 安装/分发系统：镜像源选择的收口处，npm 版本查询同源
    this.indexFile = path.join(this.cacheDir, INDEX_FILE);
    this._cache = null;
    this._ts = 0;
    this._inFlight = null;
    this._lastError = null;
    this._nextAllowAt = 0;
    // 冷启动构建失败后的重试退避：读端点每次命中「无缓存」都会点火重建，没有退避就是读一次点一轮 4 分钟。
    this.retryBackoffMs = opts.retryBackoffMs || 60000;
    // 整体构建预算（默认 4 分钟）：社区源候选约 2468 个，8 并发分批最坏可达数十分钟。
    // 到点即停止发起新批次，用已采集部分构建索引（截断源与旧缓存按 source 取并集，见 _buildIndexInner）。
    // 预算与「请求何时结束」无关：构建在后台跑，快照以 building 暴露进度（见 getIndex）。
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

  /** 索引快照，耗时上限必须是「读内存」：构建（默认预算 4 分钟）交 _requestBuild 在后台跑。
   *  挂到请求上等构建，面板 15s 计时会先放弃而服务端仍在跑 —— 用户见失败、结论却是好的。
   *  无缓存且上次构建刚失败时按 retryBackoffMs 退避，免得每次读都点燃一轮 4 分钟构建；force 不受退避约束。 */
  getIndex(force = false) {
    const need = !this._cache || force || Date.now() - this._ts >= this.ttl;
    if (need && (force || Date.now() >= this._nextAllowAt)) this._requestBuild();
    return Promise.resolve(this._view());
  }

  /** 快照视图（无缓存也返回合法空索引，绝不为取数据而触网）。 */
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

  /** 启动一次构建（无消费者 await）并登记为在飞引用；两条不变量：
   *  (a) 无人等待的失败不得成为进程级 unhandledRejection —— 给 raw 挂 no-op handler「标记已处理」；
   *  (b) 去重：已有在飞构建就直接复用，force 连点不得叠加并发构建（M-i）。
   *  失败原因记入 _lastError 并由快照如实上报 —— 取不到不能显示成「没有插件」。 */
  _requestBuild() {
    if (this._inFlight) return this._inFlight;
    const raw = this.buildIndex();
    raw.catch(() => {}); // 标记已处理：无人 await 时否则就是 unhandledRejection
    this._inFlight = raw;
    raw.then(
      () => { this._lastError = null; },
      (e) => {
        this._lastError = (e && e.message) || String(e);
        if (!this._cache) this._nextAllowAt = Date.now() + this.retryBackoffMs;
        this.logger.warn && this.logger.warn('market: 索引构建失败（沿用旧缓存）: ' + this._lastError);
      }
    ).then(() => { if (this._inFlight === raw) this._inFlight = null; });
    return raw;
  }

  async buildIndex() {
    const start = Date.now();
    // B2-6c：预算归一次构建所有，不归实例——叠建（直接 buildIndex / 去重窗口外的竞拍）时
    //   实例级 deadline 互踩：先结束者在 finally 清零，后启动者预算上限整个失效。
    const bctx = { deadline: start + this.buildBudgetMs, truncated: new Set() };
    try { return await this._buildIndexInner(start, bctx); }
    finally { bctx.deadline = 0; } // 只清自己的；bctx 随本次构建销毁
  }

  /** 预算是否已耗尽（供各源的批次循环调用；无 ctx = 单源直调，不设预算）。 */
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

    // 保护 A：被预算截断的源仍出现在结果里（只是不完整），不会触发保护 B，故与旧缓存按 source 取并集、
    // 不受 50% 比例约束（「截断」与「整源失败」语义不同，不能共用判据；否则会把完整列表换成缩水版）。
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

    // 保护 B：本次结果较旧缓存缩水 <50%（某源大面积失败/限流）时，沿用旧缓存中
    // 本次完全缺失的源，绝不因一次坏构建丢掉好缓存。
    if (prev && prev.plugins && prev.plugins.length > 0 && plugins.length < prev.plugins.length * 0.5) {
      const freshSources = new Set(plugins.map((pp) => pp.source));
      const prevByKey = new Map(prev.plugins.map((pp) => [pp.name, pp]));
      const keepPrev = prev.plugins.filter((pp) => !freshSources.has(pp.source)); // 本次整源失败 -> 沿用旧源全部
      for (const kp of keepPrev) { if (!seen.has(kp.name)) { seen.add(kp.name); plugins.push(kp); } }
      this.logger.warn && this.logger.warn('market index partial build: ' + plugins.length + ' (prev ' + prev.plugins.length + ') — 失败源已沿用旧缓存');
    }

    // 合并的旧条目未参与排序，重排保持 stars 降序（前端依赖该序）。
    plugins.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    this._cache = { indexedAt: Date.now(), sources: { npm: npm.length, github: gh.length, community: community.length }, total: plugins.length, plugins };
    this._ts = Date.now();
    this.saveToDisk();
    this.logger.info && this.logger.info('market index built in ' + (Date.now() - start) + 'ms: ' + plugins.length + ' plugins (npm=' + npm.length + ', gh=' + gh.length + ', community=' + community.length + ')');
    return this._cache;
  }

  /** npm 源：搜 deepseek-harness 受限 dsh，逐个检测 dsh.bundle。bctx 为本次构建的预算上下文（见 buildIndex）。 */
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
      // 预算耗尽即停止发起新批次（已采集部分照常返回）。
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
  /** npm 镜像源基址（经 dist 统一选择；dist 不可达降级官方源）。尾斜杠归一交给 registry-ref。 */
  async _npmOrigin() {
    let origin = null;
    if (this.dist) { try { origin = await this.dist.registryOrigin(false); } catch {} }
    return origin || REGISTRY;
  }

  /** npm 最新版元数据查询（镜像源选择见 _npmOrigin）。 */
  async safeFetchLatest(name) {
    return fetchLatest(await this._npmOrigin(), name);
  }

  /** GitHub 源：搜 topic:dsh-plugin + deepseek-harness，逐个验证 dsh.bundle。 */
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
          // 略过官方本体仓库（不是可选插件）
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

  /** 抓取 GitHub 仓库 package.json（raw）验证 dsh.bundle。 */
  async safeRepoPkg(fullName) {
    return repoPkg(fullName);
  }

  /** 社区列表：抓 awesome-dsh-plugin README 白名单（官方社区维护的精选）。 */
  async indexCommunity(bctx) {
    const out = [];
    try {
      const md = await rawGet('awesome-dsh-plugin/awesome-dsh-plugin/main/README.md', false, 30000);
      // 提取 npm 包名（- 或 [ 开头的 包名）+ GitHub 全名
      const re = /\[([^\]|]+)\]\(https:\/\/(?:www\.)?(?:npmjs\.com\/package\/([\w@\/.-]+)|github\.com\/([\w.-]+\/[\w.-]+))\)/g;
      const links = [];
      let m;
      while ((m = re.exec(md)) !== null) { links.push({ npmName: m[2], ghName: m[3], label: m[1] || '' }); }
      // 串行逐个查 npm 太慢/易整体超时 -> 8 并发批次，单条失败跳过
      const seenName = new Set();
      for (let i = 0; i < links.length; i += 8) {
        // 预算耗尽即停止（社区源候选最多，最易超时）。
        if (this._budgetExhausted(bctx)) { bctx.truncated.add("community"); this.logger.warn && this.logger.warn("market: community 源预算耗尽，已处理 " + i + "/" + links.length + " 个候选"); break; }
        const slice = links.slice(i, i + 8);
        await Promise.all(slice.map((link) => addCommunityLink(this, link, out, seenName)));
      }
    } catch (e) { this.logger.error && this.logger.error('community index fail: ' + e.message); }
    return out;
  }
}

module.exports = { PluginMarket };
