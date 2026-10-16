'use strict';

const API_DOMAINS = [
  require('./domains/tasks'),
  require('./domains/lifecycle'),
  require('./domains/native'),
  require('./domains/guard'),
  require('./domains/router'),
  require('./domains/plugins'),
  require('./domains/dist'),
  require('./domains/instances'),
  require('./domains/relay'),
  require('./domains/shell'),
];

const { SURFACE } = require('./contract');

function assertSurfaceOwned(domains) {
  const orphans = [];
  for (const entry of SURFACE || []) {
    const path = typeof entry === 'string' ? entry : entry && entry.path;
    if (!path) continue;
    const owned = domains.some((d) => typeof d.owns === 'function' && d.owns(path));
    if (!owned) orphans.push(path);
  }
  return orphans;
}

const API_DOMAINS_ORPHANS = assertSurfaceOwned(API_DOMAINS);

function assertNoOrphanSurface() {
  if (!API_DOMAINS_ORPHANS.length) return;
  throw new Error('api/router-table: SURFACE 登记表中以下路径没有任何 API 域 owns（新增路由忘记登记归属域）：'
    + API_DOMAINS_ORPHANS.join(', '));
}

module.exports = { API_DOMAINS, API_DOMAINS_ORPHANS, assertNoOrphanSurface };
