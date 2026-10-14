'use strict';

const srcpath = require('../../platform/util/srcpath');

const fs = require('node:fs');
const path = require('node:path');
const ex = require('../../platform/util/exec');
const matrix = require('../../platform/contract/matrix');
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

    // 内核包的平台化包名。
    // corePackageName 是配置项，默认 null 且全仓无任何写入点（Rust 壳侧也不下发），
    // 因此原先的 guardSelfUpdateStatus 恒定返回「未配置内核包」——界面上表现为
    // 「内核不会更新」，而真实原因是这条检查路径从未成立过，而非没有新版本。
    // 现在未配置时按平台事实推导，与壳侧 core::package_name() 同一规则。
    guardCorePkg() {
      const d = depsOf(this);
      const raw = d.config().corePackageName;
      if (raw) {
        const p = String(raw).replace(/{os}/g, matrix.osTag()).replace(/{arch}/g, matrix.current().arch);
        if (p) return p;
      }
      const cur = matrix.current();
      if (!matrix.osTag() || !cur || !cur.arch) return null;
      const SHARED = require('../../shared/shared-constants');
      return SHARED.product.npmScope + '/' + SHARED.product.corePkgPrefix + matrix.osTag() + '-' + cur.arch;
    },

    // 内核自身不做版本查询，也不再假装能做。
    // 更新唯一写入者 = 桌面壳（shell 侧 kernel_update_apply -> core_apply_inner），
    // 内核只如实报告本机装的是哪个版本；「有没有新版」由壳在它自己的通道里判断。
    // 这样「谁能更新内核」只有一处判据，不会出现壳与内核各查一次、结论可能相反的第二条路径。
    async guardSelfUpdateStatus() {
      const d = depsOf(this);
      const installed = d.guardVersion();
      const dep = deploy.detect();
      return {
        ok: true,
        pkg: d.guardCorePkg(),
        installed: installed || null,
        latest: null,
        // 由壳接管是事实而非故障：显式置 null 而不是 false ——
        // false 会被读成「已是最新」，null 才表示「本接口不回答这个问题」。
        updateAvailable: null,
        managedBy: 'desktop-shell',
        updatable: false,
        form: dep.form,
        reason: '内核更新由桌面壳统一执行（单写入者契约）；本接口只报告本机版本。',
      };
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
