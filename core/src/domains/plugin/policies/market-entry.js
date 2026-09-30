'use strict';

// 插件市场条目构造（纯，无 IO）：npm/GitHub 条目对象工厂。

const { pickAuthor } = require('./classify');

function npmEntry(name, meta) {
  return {
    name,
    version: meta.version,
    description: (meta.description || '').slice(0, 200),
    author: pickAuthor(meta),
    homepage: meta.homepage || null,
    repository: meta.repository && meta.repository.url || null,
    keywords: meta.keywords || [],
    stars: 0,
    source: 'npm',
    hasBundle: true,
  };
}

function githubEntry(meta, r) {
  return {
    name: meta.name || r.name,
    version: meta.version || null,
    description: (meta.description || r.description || '').slice(0, 200),
    author: (r.owner && r.owner.login) || null,
    homepage: r.homepage || null,
    repository: r.html_url || null,
    keywords: meta.keywords || [],
    stars: r.stargazers_count || 0,
    source: 'github',
    hasBundle: true,
  };
}

module.exports = { npmEntry, githubEntry };
