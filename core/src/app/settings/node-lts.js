'use strict';

// Node LTS 在线检查门面（本地判定 + 可刷新缓存）。
// 导出形态 { methods }，方法经 this 协作。
const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  methods: {
    /** Node LTS 状态：本地判定 + 6h 可刷新缓存，不做远端查询（避免守卫启动依赖网络）。
     *  失败返回 { ok:false, error } 由前端降级展示，绝不抛异常。 */
    async nodeLtsStatus() {
      try {
        const cacheFile = path.join(path.dirname(this.config.stateFile), 'node-lts-cache.json');
        const now = Date.now();
        let cache = null;
        try { if (fs.existsSync(cacheFile)) cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
        if (cache && now - (cache.fetchedAt || 0) < 6 * 3600 * 1000) {
          return { ok: true, ...cache, cached: true };
        }
        const ver = process.versions.node || '';
        const major = parseInt(String(ver).split('.')[0], 10) || 0;
        // LTS 建议：Node 偶数主版本为 LTS 线（保守本地判定，不作远端断言）
        const ltsLine = major % 2 === 0;
        const data = {
          current: ver,
          major,
          ltsLine,
          suggested: '当前 ' + ver + (ltsLine ? '（偶数主版本线，通常为 LTS）' : '（奇数主版本非 LTS 线，建议偶数主版本）'),
          fetchedAt: now,
        };
        try { fs.writeFileSync(cacheFile, JSON.stringify(data)); } catch {}
        return { ok: true, ...data, cached: false };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
