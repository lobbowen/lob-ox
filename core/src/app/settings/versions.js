'use strict';

const srcpath = require('../../platform/util/srcpath');

const fs = require('node:fs');
const path = require('node:path');
const ex = require('../../platform/util/exec');
const matrix = require('../../platform/contract/matrix');
const { semverCompare } = require('../../shared/version');
const deploy = require('../../platform/contract/deploy');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config: () => host.config,
      dist: () => host.dist,
      events: () => host.events,
      guardVersion: () => host.guardVersion,
      guardCorePkg: () => host.guardCorePkg(),
      readBinarySelfVersion: () => host._readBinarySelfVersion(),
      vcsRoot: () => host._vcsRoot(),
      guardVersionLocal: () => host.guardVersionLocal(),
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {

    guardCorePkg() {
      const d = depsOf(this);
      const raw = d.config().corePackageName;
      if (!raw) return null;
      return String(raw).replace(/{os}/g, matrix.osTag()).replace(/{arch}/g, matrix.current().arch) || null;
    },

    async guardSelfUpdateStatus() {
      const d = depsOf(this);
      const pkg = d.guardCorePkg();
      if (!pkg) return { ok: false, error: '未配置内核包（corePackageName）' };
      if (!d.dist() || typeof d.dist().fetchLatestVersion !== 'function') return { ok: false, error: '发布服务未初始化' };
      const dep = deploy.detect();
      if (!dep.updatable) {
        return { ok: false, error: dep.reason, form: dep.form, updatable: false };
      }
      try {
        const latest = await d.dist().fetchLatestVersion(pkg, d.config().releaseChannel || 'npm', { authoritative: true });
        const installed = d.guardVersion();
        if (!latest) return { ok: false, error: '官方源不可达或未查询到版本' };
        const updateAvailable = semverCompare(latest, installed) > 0;
        if (d.events()) d.events().append('guard_self_update_checked', { installed, latest, updateAvailable });
        return { ok: true, pkg, installed, latest, updateAvailable, form: dep.form, updatable: true };
      } catch (e) { return { ok: false, error: e.message }; }
    },

    async _readBinarySelfVersion() {
      const dep = deploy.detect();
      if (!dep.updatable || !dep.runningTarget) return null;
      try {
        const out = await ex.runOutAsync(dep.runningTarget, ['--version'], { timeoutMs: 20000 });
        const m = /lobox v([^\s]+)/.exec(out);
        return m ? m[1] : null;
      } catch { return null; }
    },

    _vcsRoot() {
      const dir = srcpath.resolvePackageRoot() || path.resolve(__dirname, '..');
      const innerGit = path.join(dir, '.git');
      let parent = path.dirname(dir);
      while (parent !== path.dirname(parent)) {
        const cand = path.join(parent, '.git');
        if (cand !== innerGit && fs.existsSync(cand)) return parent;
        parent = path.dirname(parent);
      }
      return dir;
    },

    
    async guardVersionLocal() {
      const d = depsOf(this);
      const root = d.vcsRoot();
      const [rawCommit, rawUp] = await Promise.all([
        ex.runOutAsync('git', ['-C', root, 'rev-parse', '--short', 'HEAD']),
        ex.runOutAsync('git', ['-C', root, 'rev-parse', '--abbrev-ref', '@{u}']),
      ]);
      const commit = (rawCommit || '').trim() || null;
      let upstream = 'local';
      if ((rawUp || '').trim()) upstream = 'git-repo';
      return { version: d.guardVersion(), runningVersion: d.guardVersion(), commit, updateAvailable: false, upstream, latest: d.guardVersion() };
    },

    async guardVersionCheck() {
      const d = depsOf(this);
      const base = await d.guardVersionLocal();
      if (base.upstream !== 'git-repo') return base;
      const root = d.vcsRoot();
      const fetchOk = (await ex.runOutAsync('git', ['-C', root, 'fetch', '--quiet'], { timeoutMs: 10000 })) !== null;
      if (!fetchOk) return base;
      let updateAvailable = false;
      const ahead = ((await ex.runOutAsync('git', ['-C', root, 'rev-list', '--count', 'HEAD..@{u}'], { timeoutMs: 10000 })) || '').trim();
      updateAvailable = parseInt(ahead, 10) > 0;
      const dep = deploy.detect();
      let diskVersion = null;
      if (dep.updatable) diskVersion = await d.readBinarySelfVersion();
      const updatePending = !!(diskVersion && diskVersion !== d.guardVersion());
      return { ...base, diskVersion, updatePending };
    },
  },
};
