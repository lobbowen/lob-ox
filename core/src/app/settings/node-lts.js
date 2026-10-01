'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  methods: {
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
